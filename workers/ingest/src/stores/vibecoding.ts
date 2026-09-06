import { VIBECODING_TAG } from "@/lib/live-events";
import type {
  VibeCodingNowPayload
} from "@/lib/types";
import {
  mergeAgentLimits
} from "@/lib/vibecoding-limits";
import {
  normalizeAgentLimits,
  normalizeVibeCodingNow,
  normalizeVibeCodingUsage
} from "@/lib/vibecoding-parse";
import { fanout } from "@ingest/fanout";
import { limitsMirror, nowMirror, usageMirror } from "@shared/vibecoding";

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
