import { AwaitingReport } from "@/lib/awaiting-report";
import { agentLimitsStaleMs } from "@/lib/freshness";
import { fanout, VIBECODING_TAG } from "@/lib/live-events";
import { mirrorKey } from "@/lib/redis";
import { readLiveness, withPresence } from "@/lib/reporter-liveness";
import type {
  VibeCodingAgent,
  VibeCodingNowPayload,
  VibeCodingPayload,
} from "@/lib/types";
import {
  attachAgentLimits,
  mergeAgentLimits,
  type StoredAgentLimits,
} from "@/lib/vibecoding-limits";
import {
  normalizeAgentLimits,
  normalizeVibeCodingNow,
  normalizeVibeCodingUsage,
  type ParsedVibeCodingNow,
  type ParsedVibeCodingUsage,
} from "@/lib/vibecoding-parse";

/**
 * 三份存储，按**谁产生、多久变一次**分。
 *
 * - `now`：此刻在不在用、用的是哪个模型。Mac 报，60 秒一轮，变了就推给浏览器。
 * - `usage`：token、费用、会话总数 —— 全是累计事实，Mac 报，十几分钟才动一次，
 *   只失效首屏缓存，不推送。
 * - `limits`：各 agent 账号侧的套餐与用量窗口。**容器上报器**走 `/api/ingest/agents`
 *   报，几分钟一轮、每轮必发。从前它搭 usage 的车，Mac 合盖就冻住；限额是厂商
 *   账号的事实，跟那台 Mac 无关，所以拆出去在 NAS 上 24 小时跑。
 *
 * 从前 usage 和 limits 是一份，再往前是三份（按「哪条命令产出的」划）。现在这道
 * 线是按来源划的：两台机器各报各的，站点按 id 拼成一行。
 *
 * Redis 为主、进程内存为辅，规则见 lib/redis 的 mirrorKey。
 */
const usageMirror = mirrorKey<{ payload: StoredUsage; pushedAt: number }>(
  ["vibecoding", "usage"],
  (state) => state.pushedAt,
);
const nowMirror = mirrorKey<{ payload: StoredNow; pushedAt: number }>(
  ["vibecoding", "now"],
  (state) => state.pushedAt,
);
const limitsMirror = mirrorKey<StoredAgentLimits>(
  ["vibecoding", "limits"],
  (state) => state.pushedAt,
);

/** 长间隔那份：一次采集里所有的累计量。展示名和图标跟着行走，读的时候原样取出。 */
type StoredUsage = ParsedVibeCodingUsage;

/** 短间隔那份：此刻的状态，没有任何累计量。 */
type StoredNow = ParsedVibeCodingNow;

/**
 * Mac 信封里的两个模块一律「先校验，后落库」，写留给 commit。
 *
 * telemetry 入口先准备全部 coding 模块，再调用 commit；年度模块写坏时，
 * 前面那份根本还没落库，不会留下半截 coding 状态。写不再挡着推送，
 * 见 lib/live-events 的 fanout。
 */
export function prepareVibeCodingUsage(report: unknown, receivedAt = Date.now()) {
  const payload = normalizeVibeCodingUsage(report);
  if (!payload) throw new Error("vibeCodingUsage 必须是 Mac Telemetry Hub 的用量摘要");
  return { commit: () => usageMirror.put({ payload, pushedAt: receivedAt }) };
}

export function prepareVibeCodingNow(report: unknown, receivedAt = Date.now()) {
  const payload = normalizeVibeCodingNow(report);
  if (!payload) throw new Error("vibeCodingNow 必须带 agents 数组");
  return {
    /** 推给浏览器的此刻补丁。用量还没到过也推 —— 它不依赖那份 */
    now: { agents: payload.agents } satisfies VibeCodingNowPayload,
    commit: () => nowMirror.put({ payload, pushedAt: receivedAt }),
  };
}

/**
 * `/api/ingest/agents`：容器上报器这一轮的限额，按 id 并进镜像。
 *
 * 每封都落库：上报器每轮必发，这一封就是心跳，不刷新 pushedAt 的话读那侧永远
 * 判不出它是什么时候死的。不广播 —— 限额几分钟才动一次，卡片 30 秒一轮自己来问；
 * 只推普通 tag 让首屏那份快照跟着走。第一次用 urgent：从「没有限额」到「有」，
 * 不该再给旧的降级快照顶几分钟。
 */
export async function recordAgentLimits(input: unknown, receivedAt = Date.now()) {
  const parsed = normalizeAgentLimits(input);
  if (!parsed) throw new Error("agents 必须是带 id 的限额行数组，id 不能重复");
  const previous = await limitsMirror.get();
  const first = previous == null;

  await fanout({
    writes: [limitsMirror.put(mergeAgentLimits(previous, parsed, receivedAt))],
    tags: first ? [] : [VIBECODING_TAG],
    urgentTags: first ? [VIBECODING_TAG] : [],
  });

  return { accepted: parsed.agents.length };
}

/**
 * 新鲜度只盖 pushedAt / lastSeenAt / declaredOffline / limitsAt，stale 由浏览器现算。
 */
export async function getVibeCodingSnapshot(): Promise<VibeCodingPayload> {
  const [usageState, nowState, limitsState, liveness] = await Promise.all([
    usageMirror.get(),
    nowMirror.get(),
    limitsMirror.get(),
    readLiveness(),
  ]);
  const usage = usageState ? normalizeVibeCodingUsage(usageState.payload) : null;
  // 限额可独立到达。没有用量时仍显示这些来源，累计总量保留 null。
  if (!usage && !limitsState) throw new AwaitingReport("尚未收到 vibe coding 用量或限额推送");

  const nowById = new Map(
    (nowState?.payload.agents ?? []).map((agent) => [agent.id, agent]),
  );

  const agents: VibeCodingAgent[] = attachAgentLimits(
    (usage?.agents ?? []).map((agent) => ({ ...agent, lastActivityAt: null, active: false })),
    limitsState,
  ).map((agent) => {
    const live = nowById.get(agent.id);
    return {
      ...agent,
      // 此刻模型优先于历史摘要；只有限额的行也可收到独立的本机会话状态。
      currentModel: live?.currentModel ?? agent.currentModel,
      lastActivityAt: live?.lastActivityAt ?? null,
      active: live?.active ?? false,
    };
  });

  return withPresence(
    {
      agents,
      totals: usage?.totals ?? null,
      topModels: usage?.topModels ?? [],
      collectedAt: usage?.collectedAt ?? null,
      source: "push" as const,
      pushedAt: usage && usageState ? usageState.pushedAt : null,
      limitsStaleAfterMs: agentLimitsStaleMs(),
    },
    liveness,
  );
}
