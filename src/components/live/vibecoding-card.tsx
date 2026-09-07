"use client";

import AnthropicIcon from "@lobehub/icons/es/Anthropic/components/Mono";
import AntigravityColor from "@lobehub/icons/es/Antigravity/components/Color";
import CursorIcon from "@lobehub/icons/es/Cursor/components/Mono";
import GrokIcon from "@lobehub/icons/es/Grok/components/Mono";
import OpenAIIcon from "@lobehub/icons/es/OpenAI/components/Mono";
import NumberFlow, { NumberFlowGroup } from "@number-flow/react";
import { useEffect, useState } from "react";

import { ClaudeSpinner } from "@/components/live/claude-spinner";
import { CodexActivityIndicator, CodexMark } from "@/components/live/codex-activity-indicator";
import { Card } from "@/components/ui/card";
import { useLiveEvents } from "@/hooks/use-live-events";
import { useMountedAt } from "@/hooks/use-mounted-at";
import { useReporterStale, useStale } from "@/hooks/use-stale";
import { useStatus } from "@/hooks/use-status";
import { VIBECODING_STALE_MS } from "@/lib/freshness";
import { VIBECODING_PATH } from "@/lib/paths";
import { fetchVibeCoding, seedVibeCoding } from "@/lib/vibecoding-activity";
import type {
  StatusResponse,
  VibeCodingAgent,
  VibeCodingLimit,
  VibeCodingPayload,
  VibeCodingTotals,
} from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * 信封里各个来源同一形状。首页只给这两个全量面板：限额结构、活动灯
 * 都是为它们写的。其余同一份数据，只取总限额那一行。
 */
const FEATURED_AGENT_IDS = ["claude", "codex"] as const;
const HIDDEN_AGENT_IDS = new Set(["opencode", "pi"]);

function agentDisplayName(agent: VibeCodingAgent) {
  return agent.id === "grok" ? "Grok Build" : agent.label;
}

function featuredAgents(agents: VibeCodingAgent[]) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return FEATURED_AGENT_IDS.flatMap((id) => {
    const agent = byId.get(id);
    return agent ? [agent] : [];
  });
}

function compactAgents(agents: VibeCodingAgent[]) {
  const featured = new Set<string>(FEATURED_AGENT_IDS);
  return agents.filter((agent) => !featured.has(agent.id) && !HIDDEN_AGENT_IDS.has(agent.id));
}

/**
 * 默认那一扇窗口：几条里取用量最高的，并列时留先出现的。
 *
 * 先剔掉专项窗口 —— Spark / Fable 那类不代表这个 agent 的整体余量，全量
 * 面板的主额度槽也是这么挡的（isExtraWindow），两条渲染路径得给同一个答案。
 * 已经过点的窗口按 0 参与：刚重置的那扇不该压过另一扇还有 60% 的。
 * `now` 为 0（还没挂载）时不判过期，挂载后的重渲染会自己纠正。
 */
function busiestLimit(limits: VibeCodingLimit[], now: number) {
  const candidates = limits.filter((limit) => !isExtraWindow(limit));
  if (candidates.length === 0) return null;
  const effective = (limit: VibeCodingLimit) =>
    now && limit.resetsAt != null && limit.resetsAt * 1000 <= now ? 0 : limit.usedPercent;
  return candidates.reduce((best, row) => (effective(row) > effective(best) ? row : best));
}

const REFRESH_MS = 2 * 60_000;

/**
 * 分档阈值。条和数字共用同一组，别在两处各写一遍 —— 分开写迟早改漏一个，
 * 出现「条红了数字还是蓝的」。
 *
 * 这两个数是拍的，不是上游给的：Codex 的响应带 severity 字段，Claude 那边没有，
 * 两边口径对不齐，索性都按百分比自己判，至少行为一致。
 */
const LIMIT_WARN_PERCENT = 75;
const LIMIT_ALERT_PERCENT = 90;
/**
 * 跟同文件的 TOKEN_SEGMENTS 一样直接写 oklch 字面量、不进主题变量：
 * 这是数据编码色，不该被亮暗主题改掉 —— 尤其告警那支，红就得是红。
 * 常态色沿用 TOKEN_SEGMENTS 里 Input 那支蓝，同一张卡里不再多引入一种色相。
 */
const LIMIT_BAR_COLOR = "oklch(0.63 0.18 250)";
/** 预警档。沿用同文件 Cache read 那支琥珀（也是 --live-idle 的色相），不另挑一支黄。 */
const LIMIT_WARN_COLOR = "oklch(0.72 0.16 75)";
const LIMIT_ALERT_COLOR = "oklch(0.62 0.21 25)";
/** 不受限那一档。沿用同文件 Reasoning 那支绿（也是 --live 用的那支），不再多引入一种色相。 */
const LIMIT_UNLIMITED_COLOR = "oklch(0.65 0.17 145)";

/**
 * 配速指示器那根竖线的两支颜色：用得比时钟快是红，没快是绿。
 *
 * 都是这张卡上已经有的颜色（告警那支红、不受限那支绿），不为这件事再引入新色相。
 * 条本身不受影响，仍按用量分档 —— 见 LimitMeter 里的 overPace。
 */
const LIMIT_OVER_PACE_COLOR = LIMIT_ALERT_COLOR;
const LIMIT_ON_PACE_COLOR = LIMIT_UNLIMITED_COLOR;

/** 蓝 → 琥珀 → 红，只有三档没有渐变：中间色会让人去猜具体数，而数就写在旁边 */
function limitColor(usedPercent: number) {
  if (usedPercent >= LIMIT_ALERT_PERCENT) return LIMIT_ALERT_COLOR;
  if (usedPercent >= LIMIT_WARN_PERCENT) return LIMIT_WARN_COLOR;
  return LIMIT_BAR_COLOR;
}

const TOKEN_SEGMENTS = [
  { key: "inputTokens", label: "Input", shortLabel: "IN", color: "oklch(0.63 0.18 250)" },
  { key: "outputTokens", label: "Output", shortLabel: "OUT", color: "oklch(0.68 0.15 175)" },
  {
    key: "cacheReadTokens",
    label: "Cache read",
    shortLabel: "CR",
    color: "oklch(0.72 0.16 75)",
  },
  {
    key: "cacheCreationTokens",
    label: "Cache write",
    shortLabel: "CW",
    color: "oklch(0.65 0.18 315)",
  },
] as const;

/**
 * 紧凑行的品牌图标，按上报器给的 `icon` 键取 —— 不是按 `id`：id 是
 * 用量的来源名，这个是牌子，两者不一定一致。
 *
 * 认不出来的键退回首字母。上报器新配一个来源时页面上立刻就该有一行，
 * 图标是后补的事，不该因为少一个矢量就让那行的限额也跟着看不见。
 */
function BrandMark({
  icon,
  label,
  className,
}: {
  icon: string;
  label: string;
  className?: string;
}) {
  switch (icon) {
    case "cursor":
      return <CursorIcon size={20} className={className} />;
    case "antigravity":
      return <AntigravityColor size={20} className={className} />;
    // 这个牌子只有黑白两色，Mono 就是它的本来面目，不是退而求其次
    case "grok":
      return <GrokIcon size={20} className={className} />;
    case "openai":
    case "codex":
      return <CodexMark className={className} />;
    default:
      return (
        <span
          className={cn(
            "flex items-center justify-center text-xs font-medium text-muted-foreground",
            className,
          )}
        >
          {label.slice(0, 1).toUpperCase()}
        </span>
      );
  }
}

function ModelProviderIcon({ model }: { model: string }) {
  const name = model.toLowerCase();
  const mark = name.startsWith("claude") ? (
    <AnthropicIcon size={16} />
  ) : name.startsWith("grok") ? (
    <GrokIcon size={16} />
  ) : /^(gpt|codex|chatgpt|o\d)/.test(name) ? (
    <OpenAIIcon size={16} />
  ) : null;
  if (!mark) return null;
  return (
    <span className="flex size-6 shrink-0 items-center justify-center text-foreground" aria-hidden>
      {mark}
    </span>
  );
}

/**
 * 名次色跟 AIHOT 排行榜一致：无底色圆，只是等宽加粗数字上色。
 * https://aihot.virxact.com/leaderboard
 *
 * 和同文件的 TOKEN_SEGMENTS / LIMIT_*_COLOR 一样写 oklch 字面量、不进主题变量：
 * 这是数据编码色（金银铜对齐排行榜的名次语义），不该被亮暗主题改掉。
 * 三个值是原来那三支 hex 的等价换算，往返回 sRGB 逐通道一字不差。
 */
const RANK_MARK_COLOR = [
  "oklch(0.65 0.144 33.6)",
  "oklch(0.696 0.105 52)",
  "oklch(0.777 0.099 85.5)",
] as const;

function RankMark({ rank }: { rank: number }) {
  return (
    <span
      className="shrink-0 font-mono text-sm font-bold tracking-[0.02em] text-muted-foreground"
      style={
        rank < RANK_MARK_COLOR.length
          ? { color: RANK_MARK_COLOR[rank] }
          : undefined
      }
    >
      {String(rank + 1).padStart(2, "0")}
    </span>
  );
}

/**
 * 首字母大写。空段原样返回 —— `part[0]` 在空串上是 undefined，
 * 直接 `.toUpperCase()` 会抛 TypeError。
 */
function capitalize(part: string) {
  return part ? `${part[0].toUpperCase()}${part.slice(1)}` : part;
}

/**
 * 模型名是上报器那侧的原样字符串，前端没有清洗：一条尾随连字符（`gpt-4-`）、
 * 连着两个连字符（`gpt-5--pro`）或者空串，都会切出空段来。这是渲染期调用的
 * 纯函数，抛出去就是整张卡连同「Vibe Coding」区块一起白掉，所以一律走
 * capitalize，绝不假设段非空。
 */
function formatModelName(model: string) {
  if (!model) return model;
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/i.exec(model);
  if (claude) {
    const [, family, major, minor] = claude;
    return `Claude ${capitalize(family)} ${major}${minor ? `.${minor}` : ""}`;
  }
  const gpt = /^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/i.exec(model);
  if (gpt) {
    const [, version, variant] = gpt;
    const suffix = variant ? ` ${variant.split("-").map(capitalize).join(" ")}` : "";
    return `GPT ${version}${suffix}`;
  }
  return model.split("-").map(capitalize).join(" ");
}

function TotalUsage({
  totals,
  topModels,
}: {
  totals: VibeCodingTotals;
  topModels: VibeCodingPayload["topModels"];
}) {
  const values = {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheCreationTokens: totals.cacheCreationTokens,
  };
  const stackTotal = Object.values(values).reduce((sum, value) => sum + value, 0);

  return (
    <div
      className={cn(
        "border-b border-line px-4 pt-5 md:px-5",
        topModels.length === 0 && "pb-5",
      )}
    >
      <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
        <div>
          <div className="label-mono text-muted-foreground">Tokens</div>
          <div className="mt-2 text-3xl font-medium tracking-tight md:text-4xl">
            <NumberFlow
              value={totals.totalTokens}
              locales="en-US"
              format={{ notation: "compact", maximumFractionDigits: 1 }}
            />
          </div>
        </div>
        <div title="按公开 API 价格折算">
          <div className="label-mono text-muted-foreground">Cost</div>
          <div className="mt-2 text-3xl font-medium tracking-tight md:text-4xl">
            {totals.costComplete || totals.apiEquivalentCostUSD > 0 ? (
              <NumberFlow
                value={totals.apiEquivalentCostUSD}
                locales="en-US"
                format={{
                  style: "currency",
                  currency: "USD",
                  notation: "compact",
                  maximumFractionDigits: 1,
                }}
              />
            ) : "—"}
          </div>
        </div>
        <div>
          <div className="label-mono text-muted-foreground">Active</div>
          <div className="mt-2 text-3xl font-medium tracking-tight md:text-4xl">
            <NumberFlow value={totals.activeDays} locales="en-US" />
          </div>
        </div>
        <div>
          <div className="label-mono text-muted-foreground">Sessions</div>
          <div className="mt-2 text-3xl font-medium tracking-tight md:text-4xl">
            <NumberFlow value={totals.sessionCount} locales="en-US" />
          </div>
        </div>
      </div>

      <div className="mt-6 flex h-2 overflow-hidden bg-muted" aria-hidden>
        {TOKEN_SEGMENTS.map((segment) => {
          const value = values[segment.key];
          return value > 0 ? (
            <span
              key={segment.key}
              style={{
                width: `${(value / Math.max(stackTotal, 1)) * 100}%`,
                backgroundColor: segment.color,
              }}
            />
          ) : null;
        })}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 md:flex md:flex-wrap md:gap-x-5">
        {TOKEN_SEGMENTS.map((segment) => (
          <div key={segment.key} className="flex items-center gap-1.5 text-xs md:gap-2">
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: segment.color }}
              aria-hidden
            />
            <span className="text-muted-foreground md:hidden">{segment.shortLabel}</span>
            <span className="hidden text-muted-foreground md:inline">{segment.label}</span>
            <span className="font-mono">
              <NumberFlow
                value={values[segment.key]}
                locales="en-US"
                format={{ notation: "compact", maximumFractionDigits: 1 }}
              />
            </span>
          </div>
        ))}
      </div>

      {topModels.length > 0 && (
        <div className="mt-3 border-t border-line md:py-3">
          <div className="grid divide-y divide-line md:grid-cols-3 md:divide-x md:divide-y-0">
            {topModels.map((item, index) => (
              <div
                key={item.model}
                className="flex min-w-0 items-center gap-3 py-3 md:px-4 md:py-0 md:first:pl-0 md:last:pr-0"
              >
                <RankMark rank={index} />
                <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <ModelProviderIcon model={item.model} />
                    <div className="truncate text-sm font-medium" title={item.model}>
                      {formatModelName(item.model)}
                    </div>
                  </div>
                  <div className="shrink-0 font-mono text-xs text-muted-foreground">
                    <NumberFlow
                      value={item.tokens}
                      locales="en-US"
                      format={{ notation: "compact", maximumFractionDigits: 1 }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** 判定「当日档」的上限。跨过一天的窗口按周额度那类算，不该顶替 5 小时档。 */
const SESSION_WINDOW_MAX_MINUTES = 1440;

const FEATURED_LIMITS = {
  claude: [
    { slot: "session", title: "5-hour limit" },
    { slot: "weekly", title: "Weekly · all models" },
    { slot: "fable", title: "Weekly · Fable only" },
  ],
  codex: [
    { slot: "session", title: "5-hour limit" },
    { slot: "weekly", title: "Weekly" },
    { slot: "spark-weekly", title: "Weekly · GPT-5.3-Codex-Spark" },
  ],
} as const;

type FeaturedLimitSlot =
  (typeof FEATURED_LIMITS)[keyof typeof FEATURED_LIMITS][number]["slot"];

function isNamedLimit(limit: VibeCodingLimit, name: string) {
  return `${limit.key} ${limit.label ?? ""}`.toLowerCase().includes(name);
}

function isSparkWindow(limit: VibeCodingLimit) {
  return (
    limit.key.endsWith(".tertiary") ||
    isNamedLimit(limit, "spark") ||
    isNamedLimit(limit, "bengalfox")
  );
}

function isExtraWindow(limit: VibeCodingLimit) {
  return isSparkWindow(limit) || limit.key.includes("weekly-scoped") || isNamedLimit(limit, "fable");
}

function isSessionWindow(limit: VibeCodingLimit) {
  return (
    limit.group === "session" ||
    (limit.windowMinutes != null && limit.windowMinutes < SESSION_WINDOW_MAX_MINUTES)
  );
}

function limitSlot(limit: VibeCodingLimit): "session" | "weekly" | null {
  if (isExtraWindow(limit)) return null;
  return isSessionWindow(limit) ? "session" : "weekly";
}

function pickSlotLimit(limits: VibeCodingLimit[], slot: FeaturedLimitSlot) {
  if (slot === "fable") {
    return limits.find((limit) => isNamedLimit(limit, "fable")) ?? null;
  }
  if (slot === "spark-weekly") {
    return limits.find((limit) =>
      isSparkWindow(limit) && !isSessionWindow(limit),
    ) ?? null;
  }
  const matched = limits.filter((limit) => limitSlot(limit) === slot);
  if (matched.length === 0) return null;
  if (slot === "weekly") {
    return matched.find((limit) => limit.key === "weekly_all") ?? matched[0] ?? null;
  }
  return matched.find((limit) => limit.key.endsWith(".primary")) ?? matched[0] ?? null;
}

/** 紧凑行只显示最紧的主额度窗口。 */
function compactLimit(agent: VibeCodingAgent, now: number) {
  return busiestLimit(agent.limits, now);
}

type FeaturedLimitRow =
  | { kind: "limit"; key: string; title: string; limit: VibeCodingLimit }
  | { kind: "unlimited"; key: string; title: string }
  | { kind: "unavailable"; key: string; title: string; reason: string };

/**
 * 固定三行：Claude 的主额度加 Fable；Codex 的主额度加 Spark 周额度。
 * Codex 成功取数但没有主 5 小时窗口时显示 Unlimited；采集报错仍显示 Unavailable。
 */
function featuredLimitRows(agent: VibeCodingAgent): FeaturedLimitRow[] {
  const slots: ReadonlyArray<{ slot: FeaturedLimitSlot; title: string }> =
    agent.id === "claude" ? FEATURED_LIMITS.claude : FEATURED_LIMITS.codex;
  return slots.map(({ slot, title }) => {
    const limit = pickSlotLimit(agent.limits, slot);
    if (limit) return { kind: "limit" as const, key: slot, title, limit };
    if (agent.id === "codex" && slot === "session" && agent.limitsAt != null && agent.limitsError == null) {
      return { kind: "unlimited" as const, key: slot, title };
    }
    return {
      kind: "unavailable" as const, key: slot, title,
      reason: agent.limitsError ?? "尚未收到此窗口的限额",
    };
  });
}

/**
 * 重置时刻。
 *
 * 一天以内说还剩多久，超过一天直接报星期几几点 —— 「2 天 13 小时后」要在脑子里
 * 换算一次才知道是哪天，而周额度重置本来就是个固定时刻，直接说更省事。
 * 跟 Claude Code 自己 /usage 面板的分档一致。
 *
 * resetsAt 是 Unix 秒，不是毫秒。
 */
type ResetDisplay =
  /** 一天以内：时和分要滚，所以拆成数字，不拼成整句 */
  | { kind: "relative"; hours: number; minutes: number }
  /** 超过一天：是个固定时刻，不随时间变，也就没有可滚的 */
  | { kind: "absolute"; text: string };

function formatReset(resetsAt: number | null, referenceTime: number): ResetDisplay | null {
  if (resetsAt == null) return null;
  const remain = resetsAt * 1000 - referenceTime;
  // 已经过点了就不显示：这份快照只是还没刷新，倒计时写成负数更容易让人误会
  if (remain <= 0) return null;
  if (remain >= 86_400_000) {
    // 四舍五入到整分：同时重置的两条上游给的是 02:59:59 和 03:00:00，
    // 直接截断会显示成差一分钟，看着像两个不同的时刻
    const at = new Date(Math.round(resetsAt / 60) * 60_000);
    // 分两次格式化：合在一起 en-US 会插一个逗号（"Mon, 11:00 AM"）
    const weekday = at.toLocaleString("en-US", { weekday: "short" });
    const clock = at.toLocaleString("en-US", { hour: "numeric", minute: "2-digit" });
    return { kind: "absolute", text: `Resets ${weekday} ${clock}` };
  }
  const totalMinutes = Math.floor(remain / 60_000);
  return {
    kind: "relative",
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
  };
}

/**
 * 距离下一次「显示会变」还有多久。
 *
 * 只在文案真的会变的时刻醒，不做无谓的定时重渲染：
 *
 * - 超过一天时显示的是「Resets Mon 11:00 AM」，那句话跟时间流逝无关，
 *   一直等到它跌破一天、要换成相对写法时才需要醒。周额度因此几小时才醒一次。
 * - 一天以内显示到分钟，所以在每个整分边界醒一次。
 * - 剩不到一分钟时直接等到点，那一下要同时翻文案和把条归零。
 */
function nextTickDelay(remain: number) {
  if (remain > 86_400_000) return remain - 86_400_000;
  if (remain <= 60_000) return Math.max(0, remain);
  return remain % 60_000 || 60_000;
}

/**
 * 紧凑行的重置文案。
 *
 * 全量面板的窗口写着 Weekly，报「Resets Mon 11:00 AM」不会误会是哪一周。
 * 这里没有窗口名：Cursor 可能是月、Antigravity 是周，用星期几就会歧义，
 * 一律说还剩几天 / 几小时。
 */
type CompactResetDisplay =
  | { kind: "relative"; hours: number; minutes: number }
  | { kind: "days"; days: number; hours: number };

function formatCompactReset(
  resetsAt: number | null,
  referenceTime: number,
): CompactResetDisplay | null {
  if (resetsAt == null) return null;
  const remain = resetsAt * 1000 - referenceTime;
  if (remain <= 0) return null;
  if (remain >= 86_400_000) {
    return {
      kind: "days",
      days: Math.floor(remain / 86_400_000),
      hours: Math.floor((remain % 86_400_000) / 3_600_000),
    };
  }
  const totalMinutes = Math.floor(remain / 60_000);
  return {
    kind: "relative",
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
  };
}

/**
 * 配速指示器自己的刷新节奏：让它每次大约挪动 0.2% 的宽度。
 *
 * 不能搭 nextTickDelay 的车 —— 那个是给重置倒计时排的，剩余超过一天时它一觉睡到
 * 「还剩 24 小时」，7 天那条窗口的指示器会几天不动。上下限是防两头：5 小时窗口
 * 按 0.2% 算是 36 秒，太密；7 天窗口是 20 分钟，太疏。
 */
function paceTickInterval(windowMs: number) {
  return Math.min(Math.max(windowMs / 500, 60_000), 10 * 60_000);
}

/**
 * 这个限额窗口走到哪儿了（0~1），指示器就钉在这个位置。
 *
 * 窗口起点由 `resetsAt - windowMinutes` 反推 —— 两个字段缺一就返回 null，那时不画
 * 指示器。**不能拿 `group` 里那个 "weekly" 当七天用**，契约里明写着展示层不得由分组
 * 反推窗口时长（见 types 的 VibeCodingLimit）。眼下 Grok 和 Antigravity 就是只给了
 * resetsAt 没给窗口时长，知道什么时候结束推不出什么时候开始。
 *
 * `now` 为 0（首帧还没有访客钟）时也返回 null：这是拿当下时刻算的东西，服务端那一遍
 * 算不得数，画了必然水合不一致。
 */
function limitPace(limit: VibeCodingLimit, now: number): number | null {
  if (!now || limit.windowMinutes == null || limit.resetsAt == null) return null;
  const windowMs = limit.windowMinutes * 60_000;
  if (windowMs <= 0) return null;
  const remain = limit.resetsAt * 1000 - now;
  // 已经过点了：新周期刚从头开始
  if (remain <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - remain / windowMs));
}

/**
 * 配速指示器：这个周期走到哪儿了。用量条超过它说明用得比时钟快，标记变红；没超是绿。
 *
 * 两侧各切开一小段底色，标记才不会和「已用」那段糊成一片。整块 6px 宽，居中 2px 是
 * 标记本身；往左挪半个身位，让它正落在刻度上而不是刻度右边。
 */
function PaceMarker({ pace, overPace }: { pace: number; overPace: boolean }) {
  // 只在周期进度 10%–90%（含边界）之间显示，避免贴住限额条两端。
  if (pace < 0.1 || pace > 0.9) return null;

  return (
    <span
      aria-hidden
      className="absolute inset-y-0 flex w-1.5 justify-center bg-surface"
      style={{ left: `calc(${pace * 100}% - 3px)` }}
    >
      <span
        className="w-0.5"
        style={{ backgroundColor: overPace ? LIMIT_OVER_PACE_COLOR : LIMIT_ON_PACE_COLOR }}
      />
    </span>
  );
}

/** 超过一天时按小时刷新，一天以内按分钟。 */
function nextCompactTickDelay(remain: number) {
  if (remain > 86_400_000) return remain % 3_600_000 || 3_600_000;
  if (remain <= 60_000) return Math.max(0, remain);
  return remain % 60_000 || 60_000;
}

function LimitMeter({ limit, title }: { limit: VibeCodingLimit; title: string }) {
  /**
   * 自己盯着重置时刻，不跟面板其它部分共用快照时间。
   *
   * 快照时间是采集那一刻，用它当基准的话「重置到点了」这件事前端永远感知不到 ——
   * 倒计时是冻住的，只在新数据到达时跳一下。NAS 上报器几分钟才重取一次限额，
   * 再等站点轮询，这段时间里这根条会一直显示上一个周期的百分比。
   * 那个数是确定错的：周期已经翻篇了。
   *
   * 到点归零不是编数据 —— 重置那一刻用量就是零。之后至多低估这几分钟新用掉的
   * 量，比挂着一个上个周期的旧值准得多。
   *
   * 用一次性 setTimeout 而不是轮询式计时器：数据没变时轮询不会触发重渲染
   * （响应体已经不带时间戳了），光靠重渲染永远跨不过那个时刻；而定时器只在
   * 边界醒这一次，中间一点开销都没有。
   *
   * 首帧 now 是 0（见 useMountedAt），倒计时整块不画：它和「已过期」都是拿当下
   * 时刻算的，服务端那一遍算不得数 —— 超过一天的那支写成绝对时刻，
   * toLocaleString 不带 timeZone，服务端和访客各按各的时区格式化，水合必然对不
   * 上。行高由下面的 h-5 钉着，晚一拍出现也不会把版面顶开。
   */
  const mountedAt = useMountedAt();
  const [ticked, setTicked] = useState(0);
  const now = ticked || mountedAt;
  useEffect(() => {
    // 还没挂载就没有基准可排，等 now 落地这个 effect 会再跑一遍
    if (!now || limit.resetsAt == null) return;
    const target = limit.resetsAt * 1000;
    // 已经跨过去了就不再排，否则下面每轮都会重排定时器，停不下来
    if (now >= target) return;
    /**
     * 延迟按真实当下算，不能用 now 去减。
     *
     * now 是上一次醒来时的快照；拿它算差值等于把「now 已经落后多久」又加了
     * 一遍，定时器会排到远超目标时刻之后。实测那样会晚三分钟才归零。
     */
    const timer = window.setTimeout(
      () => setTicked(Date.now()),
      // 多等半秒，避开时钟精度导致醒来时刚好差几毫秒没到点
      nextTickDelay(target - Date.now()) + 500,
    );
    return () => window.clearTimeout(timer);
  }, [limit.resetsAt, now]);

  const expired = limit.resetsAt != null && limit.resetsAt * 1000 <= now;
  const usedPercent = expired ? 0 : limit.usedPercent;

  /**
   * 指示器要自己往前走。
   *
   * 上面那个定时器是给重置倒计时排的，剩余超过一天时它一觉睡到「还剩 24 小时」——
   * 7 天那条窗口的指示器会几天钉在挂载时的位置上。数据每轮轮询都在刷新，但 `now`
   * 只有定时器醒来才动，光靠新数据到达它不会挪。
   */
  const windowMs = limit.windowMinutes != null ? limit.windowMinutes * 60_000 : null;
  useEffect(() => {
    if (!now || windowMs == null || windowMs <= 0) return;
    const timer = window.setInterval(() => setTicked(Date.now()), paceTickInterval(windowMs));
    return () => window.clearInterval(timer);
  }, [now, windowMs]);

  const pace = limitPace(limit, now);
  const overPace = pace != null && usedPercent / 100 > pace;
  const color = limitColor(usedPercent);
  // 基准跟着上面那个 now，条和文案才会在同一刻翻面
  const reset = now ? formatReset(limit.resetsAt, now) : null;

  return (
    <div>
      {/*
        行高钉死，不让内容决定。

        NumberFlow 是个 inline-block 的 web component，会把 text-xs 的行盒从
        16px 撑到 20px。限额窗口有的带重置倒计时、有的没有，因此两侧面板的
        行高可能不一样，两侧全量面板的进度条整列也会跟着错位。

        改 items-center：几个子元素都是 text-xs，视觉上和原来的 items-baseline
        没有区别，但不再受 NumberFlow 合成基线的影响。
      */}
      <div className="flex h-5 items-center justify-between gap-2">
        <span className="truncate text-xs" title={title}>
          {title}
        </span>
        <span className="flex shrink-0 items-baseline gap-2">
          {reset?.kind === "absolute" && (
            <span className="text-xs text-muted-foreground">{reset.text}</span>
          )}
          {reset?.kind === "relative" && (
            /* 和充电头的瓦数同一种滚动。套 NumberFlowGroup 才能让 59→00 那一下
               时和分同时翻，否则各滚各的、时间差看得出来 */
            <NumberFlowGroup>
              <span className="text-xs tabular-nums text-muted-foreground">
                Resets in{" "}
                {reset.hours > 0 && (
                  <>
                    <NumberFlow value={reset.hours} locales="en-US" /> hr{" "}
                  </>
                )}
                {/* 整点时不写「0 min」，读着像没写完 */}
                {(reset.minutes > 0 || reset.hours === 0) && (
                  <>
                    <NumberFlow value={reset.minutes} locales="en-US" /> min
                  </>
                )}
              </span>
            </NumberFlowGroup>
          )}
          <span className="font-mono text-xs tabular-nums" style={{ color }}>
            <NumberFlow value={Math.round(usedPercent)} locales="en-US" />%
          </span>
        </span>
      </div>
      <div className="relative mt-1.5 h-1.5 overflow-hidden bg-muted">
        <div
          className="h-full transition-[width] duration-700"
          style={{ width: `${usedPercent}%`, backgroundColor: color }}
        />
        {pace != null && <PaceMarker pace={pace} overPace={overPace} />}
      </div>
    </div>
  );
}

function LimitUnlimited({ title }: { title: string }) {
  return (
    <div>
      <div className="flex h-5 items-center justify-between gap-2">
        <span className="truncate text-xs">{title}</span>
        <span className="flex shrink-0 items-baseline gap-2">
          <span className="text-xs text-muted-foreground">Unlimited</span>
          <span className="font-mono text-xs tabular-nums" style={{ color: LIMIT_UNLIMITED_COLOR }}>
            <span className="inline-block origin-right scale-[1.6]">∞</span>
          </span>
        </span>
      </div>
      <div className="mt-1.5 h-1.5" style={{ backgroundColor: LIMIT_UNLIMITED_COLOR }} />
    </div>
  );
}

/** 预期有但取不到的窗口，保留原位以免整行消失。 */
function LimitUnavailable({ title, reason }: { title: string; reason: string }) {
  return (
    <div title={reason}>
      <div className="flex h-5 items-center justify-between gap-2">
        <span className="truncate text-xs">{title}</span>
        <span className="flex shrink-0 items-baseline gap-2">
          <span className="text-xs text-muted-foreground">Unavailable</span>
          <span className="label-mono text-muted-foreground">—</span>
        </span>
      </div>
      <div className="mt-1.5 h-1.5 bg-muted" />
    </div>
  );
}

function FeaturedMark({ id, active }: { id: string; active: boolean }) {
  if (id === "claude") return <ClaudeSpinner active={active} />;
  return <CodexActivityIndicator active={active} />;
}

function AgentPanel({
  agent,
  /** 采集侧的话还算不算数，见 VibeCodingCard 里的 activityUnknown */
  activityUnknown,
  limitsStaleAfterMs,
}: {
  agent: VibeCodingAgent;
  activityUnknown: boolean;
  /** 限额那条路的陈旧窗口，见 VibeCodingPayload */
  limitsStaleAfterMs: number;
}) {
  /**
   * 限额是另一台机器（NAS 上的容器上报器）报的，每轮必发，所以「多久没来」就是
   * 「它还活着没有」。陈旧时条照画 —— 数字停在最后一次看到的值，但要说明白：
   * 这一块是**上一次**的，别让访客拿它当此刻的余量。
   */
  const limitsStale = useStale(agent.limitsAt, limitsStaleAfterMs);
  const today = agent.today;
  // error 也可能只是本轮成功采集后的缺项提示；是否为今日取决于日桶和成功时间。
  const dayStart = today ? Date.parse(`${today.date}T00:00:00+08:00`) : null;
  const dayHasEnded = useStale(dayStart, 86_400_000);
  const collectedAt = agent.usageStatus.collectedAt ? Date.parse(agent.usageStatus.collectedAt) : null;
  const isToday = dayStart != null && collectedAt != null
    && collectedAt >= dayStart && collectedAt < dayStart + 86_400_000 && !dayHasEnded;
  const promptTokens =
    (today?.inputTokens ?? 0) +
    (today?.cacheCreationTokens ?? 0) +
    (today?.cacheReadTokens ?? 0);
  // 命中只认 cache read；cache creation 是新写入，不能算作命中。
  // output 与 prompt cache 无关，也不应该进入分母。
  const cacheHitRate = promptTokens
    ? ((today?.cacheReadTokens ?? 0) / promptTokens) * 100
    : 0;
  /**
   * `agent.active` 是推来的电平，不是会自己过期的时间戳：采集侧一停就冻在最后
   * 一次推送的值上。所以点灯前要和「这句话现在还算不算数」取与 —— 否则 Mac 睡
   * 着时那盏灯会一直亮，直到它醒来才灭。
   */
  const active = agent.active && !activityUnknown;
  // 会话扫描会保留最近使用的模型，闲置后继续显示它。
  const displayModel = agent.currentModel ?? "暂无模型";
  const rows = featuredLimitRows(agent);
  return (
    <div className="flex min-w-0 flex-col px-4 py-4 md:px-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FeaturedMark id={agent.id} active={active} />
          <span className="text-sm font-medium">{agentDisplayName(agent)}</span>
          {active && <span className="label-mono text-live">正在使用</span>}
        </div>
        <span
          className={cn(
            "label-mono truncate",
            active ? "text-live" : "text-muted-foreground",
          )}
          title={agent.models.join(" · ")}
        >
          {displayModel}
        </span>
      </div>

      <div className="mt-5 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-5">
        <div className="min-w-0">
          <div className="label-mono text-muted-foreground">
            {today && !isToday ? `Tokens · ${today.date}` : "Today Tokens"}
          </div>
          <div className="mt-1 text-3xl font-medium tracking-tight tabular-nums md:text-5xl">
            {today ? (
              <NumberFlow
                value={today.totalTokens}
                locales="en-US"
                format={{ notation: "compact", maximumFractionDigits: 1 }}
              />
            ) : "—"}
          </div>
        </div>
        <div className="grid gap-3 border-l border-line pl-4">
          <div title="按公开 API 价格折算">
            <div className="label-mono text-muted-foreground">Cost</div>
            <div className="mt-1 font-mono text-sm">
              {today && (agent.usageStatus.costComplete || today.apiEquivalentCostUSD > 0)
                ? `$${today.apiEquivalentCostUSD.toFixed(2)}`
                : "—"}
            </div>
          </div>
          <div>
            <div className="label-mono text-muted-foreground">Hit</div>
            <div className="mt-1 font-mono text-sm">{today ? `${cacheHitRate.toFixed(1)}%` : "—"}</div>
          </div>
        </div>
      </div>

      <div
        className={cn("mt-5 grid gap-3 border-t border-line pt-4", limitsStale && "opacity-60")}
        title={limitsStale ? "限额上报器没有消息，这是上一次的值" : undefined}
      >
        <div className="label-mono text-muted-foreground">
          Limits
          {agent.plan && (
            <span title={`套餐 ${agent.plan.tier}`}>
              <span aria-hidden className="mx-1.5">
                ·
              </span>
              <span className="font-sans normal-case">{agent.plan.label}</span>
            </span>
          )}
          {limitsStale && (
            <span>
              <span aria-hidden className="mx-1.5">
                ·
              </span>
              Stale
            </span>
          )}
        </div>
        {rows.map((row) =>
          row.kind === "limit" ? (
            <LimitMeter key={row.key} limit={row.limit} title={row.title} />
          ) : row.kind === "unlimited" ? (
            <LimitUnlimited key={row.key} title={row.title} />
          ) : (
            <LimitUnavailable key={row.key} title={row.title} reason={row.reason} />
          ),
        )}
      </div>
    </div>
  );
}

function CompactAgentRow({
  agent,
  limitsStaleAfterMs,
}: {
  agent: VibeCodingAgent;
  limitsStaleAfterMs: number;
}) {
  // 和全量面板同一个判断：限额上报器多久没来，这一行就是上一次的值
  const limitsStale = useStale(agent.limitsAt, limitsStaleAfterMs);
  const mountedAt = useMountedAt();
  const [ticked, setTicked] = useState(0);
  const now = ticked || mountedAt;
  const limit = compactLimit(agent, now);
  const usedPercentValue = limit?.usedPercent ?? null;
  const resetsAt = limit?.resetsAt ?? null;
  useEffect(() => {
    if (!now || resetsAt == null) return;
    const target = resetsAt * 1000;
    if (now >= target) return;
    const timer = window.setTimeout(
      () => setTicked(Date.now()),
      nextCompactTickDelay(target - Date.now()) + 500,
    );
    return () => window.clearTimeout(timer);
  }, [resetsAt, now]);

  const expired = resetsAt != null && resetsAt * 1000 <= now;
  const usedPercent =
    usedPercentValue == null ? null : expired ? 0 : usedPercentValue;
  const color = usedPercent == null ? undefined : limitColor(usedPercent);
  const reset = now ? formatCompactReset(resetsAt, now) : null;

  /**
   * 配速指示器，和上面全量面板的限额条同一套。
   *
   * 这一行画的是 compactLimit 挑出的那条，所以指示器跟着的也是它。
   * 上面那个定时器最疏是按小时醒，31 天的窗口一小时才挪 0.13% —— 够用，但仍然
   * 单排一个：那个定时器的节奏是给重置倒计时定的，不该让指示器跟着它的取舍走。
   */
  const windowMs = limit?.windowMinutes != null ? limit.windowMinutes * 60_000 : null;
  useEffect(() => {
    if (!now || windowMs == null || windowMs <= 0) return;
    const timer = window.setInterval(() => setTicked(Date.now()), paceTickInterval(windowMs));
    return () => window.clearInterval(timer);
  }, [now, windowMs]);

  const pace = limit ? limitPace(limit, now) : null;
  const overPace = pace != null && usedPercent != null && usedPercent / 100 > pace;

  return (
    <div
      className={cn("min-w-0 py-3", limitsStale && "opacity-60")}
      title={
        limitsStale
          ? "限额上报器没有消息，这是上一次的值"
          : (agent.limitsError ?? undefined)
      }
    >
      <div className="flex flex-col gap-1 md:h-5 md:flex-row md:items-center md:justify-between md:gap-2">
        <div className="flex h-5 min-w-0 items-center gap-2">
          <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden>
            <BrandMark icon={agent.icon} label={agent.label} className="size-5" />
          </span>
          <span className="truncate text-sm font-medium">{agentDisplayName(agent)}</span>
        </div>
        <span className="flex h-5 min-w-0 items-baseline text-xs text-muted-foreground md:shrink-0">
          {agent.plan && (
            <span className="truncate" title={`套餐 ${agent.plan.tier}`}>
              {agent.plan.label}
            </span>
          )}
          {agent.plan && reset && (
            <span aria-hidden className="mx-1.5">
              /
            </span>
          )}
          {reset?.kind === "days" && (
            <NumberFlowGroup>
              <span className="tabular-nums">
                Resets in{" "}
                <NumberFlow value={reset.days} locales="en-US" />{" "}
                {reset.days === 1 ? "day" : "days"}
                {reset.hours > 0 && (
                  <>
                    {" "}
                    <NumberFlow value={reset.hours} locales="en-US" /> hr
                  </>
                )}
              </span>
            </NumberFlowGroup>
          )}
          {reset?.kind === "relative" && (
            <NumberFlowGroup>
              <span className="tabular-nums">
                Resets in{" "}
                {reset.hours > 0 && (
                  <>
                    <NumberFlow value={reset.hours} locales="en-US" /> hr{" "}
                  </>
                )}
                {(reset.minutes > 0 || reset.hours === 0) && (
                  <>
                    <NumberFlow value={reset.minutes} locales="en-US" /> min
                  </>
                )}
              </span>
            </NumberFlowGroup>
          )}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-3">
        <div className="relative h-1.5 min-w-8 flex-1 overflow-hidden bg-muted">
          {usedPercent != null && (
            <div
              className="h-full transition-[width] duration-700"
              style={{ width: `${usedPercent}%`, backgroundColor: color }}
            />
          )}
          {pace != null && <PaceMarker pace={pace} overPace={overPace} />}
        </div>
        {usedPercent == null ? (
          <span
            className="label-mono shrink-0 text-muted-foreground"
            title="Unavailable"
          >
            —
          </span>
        ) : (
          <span
            className="shrink-0 font-mono text-xs tabular-nums"
            style={{ color }}
          >
            <NumberFlow value={Math.round(usedPercent)} locales="en-US" />%
          </span>
        )}
      </div>
    </div>
  );
}

function CompactAgents({
  agents,
  limitsStaleAfterMs,
}: {
  agents: VibeCodingAgent[];
  limitsStaleAfterMs: number;
}) {
  if (agents.length === 0) return null;
  // 排序不看过期（now 传 0）：这里只定行序，行内画什么由行自己判
  const sortedAgents = [...agents].sort((left, right) => {
    const leftUsed = compactLimit(left, 0)?.usedPercent ?? -1;
    const rightUsed = compactLimit(right, 0)?.usedPercent ?? -1;
    return rightUsed - leftUsed;
  });
  /*
   * 竖向不留内边距：每行自己的 py-3 就是间距。容器再加一层的话，首尾到边框是
   * 16+12，行与行之间只有 12 —— 上边框和行间那几条分隔线是同一种线，眼睛会拿
   * 它们互相比，差出来的那截看着就是没对齐。
   */
  return (
    <div className="border-t border-line px-4 md:px-5">
      <div className="grid divide-y divide-line">
        {sortedAgents.map((agent) => (
          <CompactAgentRow
            key={agent.id}
            agent={agent}
            limitsStaleAfterMs={limitsStaleAfterMs}
          />
        ))}
      </div>
    </div>
  );
}

export function VibeCodingCard({
  fallback,
  className,
}: {
  fallback: StatusResponse<VibeCodingPayload>;
  className?: string;
}) {
  // 会话状态（正在用 / 换模型）走推送；token 用量和限额仍靠轮询。
  // 这张卡整体不当实时源：不因 Mac 掉线变灰 —— 用量、曲线都是累计事实，
  // 采集停了它们只是不再增长，不会变得不可信。限额是另一台机器报的，
  // 有自己的陈旧判断（limitsAt），各行自己管。
  useLiveEvents();
  const { data } = useStatus<VibeCodingPayload>(VIBECODING_PATH, REFRESH_MS, {
    fallback,
    fetcher: fetchVibeCoding,
    seedFallback: seedVibeCoding,
  });

  /**
   * 例外只有一处：两个 agent 的活动灯。整张卡就这一处说的是「此刻」，
   * 而它偏偏是全卡最不该冻住的东西 —— 剩下的冻住只是停在昨天，它冻住是在说谎。
   *
   * 两个判据取或，规矩见 lib/reporter-liveness 的模块注释：
   *
   * - **Mac 不在线**：整条上报链路断了，最后那个 active 再没人来改。
   * - **采集侧自己卡住**：Mac 在线，但用量那份十几分钟没推新的（健康时每个
   *   采集间隔必发一次），说明采集侧不转了 —— 此刻那份也就跟着不可信。
   *   `pushedAt` 盯的正是用量那份，见 VibeCodingPayload。
   *
   * 不学 live-desk-card 那样拿 `isValidating` 挡一手：那边挡的是「回源没完成时
   * 别把整块内容判没」，而这里判错的方向是安全的 —— 多说一句「没在用」只是少
   * 报，下一轮就纠正回来；反过来在 Mac 睡着时还点着灯是实打实的错。
   *
   * 两个 hook 都要无条件调用，别写成 `useReporterStale(...) || useStale(...)` ——
   * `||` 会短路掉后一个。
   */
  const { offline: reporterOffline } = useReporterStale(data);
  const collectorStale = useStale(data?.pushedAt, VIBECODING_STALE_MS);
  const activityUnknown = reporterOffline || collectorStale;

  return (
    <Card
      id="vibe-coding"
      label="Vibe Coding"
      action="MacBook Pro"
      className={cn("md:col-span-2", className)}
    >
      {data ? (
        <>
          {data.totals ? (
            <TotalUsage totals={data.totals} topModels={data.topModels} />
          ) : (
            <div className="border-b border-line px-4 py-5 text-sm text-muted-foreground md:px-5">
              等待用量上报
            </div>
          )}
          <div className="grid grid-cols-1 divide-y divide-line md:grid-cols-2 md:divide-x md:divide-y-0">
            {featuredAgents(data.agents).map((agent) => (
              <AgentPanel
                key={agent.id}
                agent={agent}
                activityUnknown={activityUnknown}
                limitsStaleAfterMs={data.limitsStaleAfterMs}
              />
            ))}
          </div>
          <CompactAgents
            agents={compactAgents(data.agents)}
            limitsStaleAfterMs={data.limitsStaleAfterMs}
          />
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-5 border-b border-line px-5 py-5 md:grid-cols-3">
            {[0, 1, 2].map((index) => (
              <div key={index} className="animate-pulse">
                <div className="h-3 w-20 rounded bg-muted" />
                <div className="mt-3 h-9 w-24 rounded bg-muted" />
              </div>
            ))}
          </div>
          <div className="grid min-h-64 grid-cols-1 divide-y divide-line md:grid-cols-2 md:divide-x md:divide-y-0">
            {["Claude Code", "Codex"].map((label) => (
              <div key={label} className="animate-pulse px-5 py-4">
                <div className="flex items-center gap-2">
                  <div className="h-4 w-24 rounded bg-muted" />
                  {/* 套餐 badge 的位置 */}
                  <div className="h-4 w-14 bg-muted" />
                </div>
                <div className="mt-6 h-12 w-36 rounded bg-muted" />
                {/* 与全量面板一致的三行限额占位 */}
                <div className="mt-6 h-1.5 bg-muted" />
                <div className="mt-3 h-1.5 bg-muted" />
                <div className="mt-3 h-1.5 bg-muted" />
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}
