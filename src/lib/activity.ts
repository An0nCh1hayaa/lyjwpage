import { AwaitingReport } from "@/lib/awaiting-report";
import { localDate } from "@/lib/freshness";
import { number, object, text } from "@/lib/json";
import { mirrorKey } from "@/lib/redis";
import type { ActivityPayload, ActivityStatus } from "@/lib/types";

/**
 * Apple Watch 的活动圆环 + 当天步数。
 *
 * 喂它的是 iPhone 上那个自己写的上报器（`reporters/iphone-telemetry-hub`）：从
 * HealthKit 读 `HKActivitySummary`，一次把三环的**已完成和目标**都拿到 —— 目标只有
 * 原生 App 读得到，所以它不在站点这侧配，跟着报文走。
 *
 * 这条路上**没有实时推送**。圈以分钟为尺度涨，为它开一路广播就是拿推送当轮询用
 * ——和时区模块同一个判断：失效是白给的，广播才是按人头付钱的。上报只让首屏那份
 * 缓存失效，卡片按 5 分钟自己来问。
 */

/** 一周。手机关机几天回来时，卡片该说的是「这是上周五那圈」，不是「从没收到过」 */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type StoredActivity = {
  activity: ActivityStatus;
  /** 源站收到的时刻 */
  receivedAt: number;
};

const mirror = mirrorKey<StoredActivity>(
  ["activity", "today"],
  (state) => state.receivedAt,
  { ttlMs: TTL_MS },
);

const DATE_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

/** 非负的必填数。三环的已完成值走它 */
function amount(value: unknown, field: string): number {
  const parsed = number(value);
  if (parsed == null) throw new Error(`活动上报的 ${field} 必须是数字`);
  if (parsed < 0) throw new Error(`活动上报的 ${field} 不能为负`);
  return parsed;
}

/**
 * 目标值必须为正 —— 环的比例是「已完成 / 目标」，0 会让它变成 0/0。
 *
 * 上报器在手表当天还没有 `HKActivitySummary` 时（刚过午夜、手表还没同步）整封不发，
 * 所以收到 0 说明那边算错了，不该默默存进去。
 */
function goal(value: unknown, field: string): number {
  const parsed = amount(value, field);
  if (parsed === 0) throw new Error(`活动上报的 ${field} 必须大于 0`);
  return parsed;
}

/** 选填的计数。上报器没拿到那项授权时整个字段不出现，那不是错误 */
function optional(value: unknown): number | null {
  if (value == null) return null;
  const parsed = number(value);
  return parsed == null || parsed < 0 ? null : Math.round(parsed);
}

/**
 * 把上报器的报文收敛成对外契约。
 *
 * `date` 和 `secondsFromGMT` 都必填，站点不给它们兜底：圆环在**手表所在时区**的
 * 午夜归零，源站的钟在别的大洲上，猜一个只会猜错。上报器那边这两个值是从
 * summary 自己的 `dateComponents` 推的，不是另拿 `Date()` 算的 —— 午夜前后两者
 * 会差一天。
 */
export function normalizeActivity(
  input: unknown,
  receivedAt = Date.now(),
): StoredActivity {
  const row = object(input);
  if (!row) throw new Error("活动上报必须是 JSON 对象");

  const date = text(row.date);
  if (!date || !DATE_PATTERN.test(date)) {
    throw new Error("活动上报的 date 必须是 YYYY-MM-DD");
  }

  const secondsFromGMT = number(row.secondsFromGMT);
  if (secondsFromGMT == null || Math.abs(secondsFromGMT) > 18 * 3600) {
    throw new Error("活动上报的 secondsFromGMT 必须是秒数，且在 ±18 小时内");
  }

  return {
    activity: {
      date,
      secondsFromGMT,
      // 三环一律取整：手表上显示的就是整数，多带的小数只会让每次上报的字节都不一样，
      // 而 SWR 靠深比较决定要不要重渲染（见 StatusResponse 的注释）
      moveKcal: Math.round(amount(row.moveKcal, "moveKcal")),
      moveGoalKcal: Math.round(goal(row.moveGoalKcal, "moveGoalKcal")),
      exerciseMinutes: Math.round(amount(row.exerciseMinutes, "exerciseMinutes")),
      exerciseGoalMinutes: Math.round(goal(row.exerciseGoalMinutes, "exerciseGoalMinutes")),
      standHours: Math.round(amount(row.standHours, "standHours")),
      standGoalHours: Math.round(goal(row.standGoalHours, "standGoalHours")),
      steps: optional(row.steps),
      distanceMeters: optional(row.distanceMeters),
      flightsClimbed: optional(row.flightsClimbed),
    },
    receivedAt,
  };
}

/**
 * 落库。整份替换，后到的就是对的。
 *
 * **没有「旧的不许盖新的」那道闸，也不该有。** 上报器每封都发当天的全量绝对值、
 * 发的都是它此刻看到的真相，而且失败了不补发旧报文（见那边的 README）—— 这两件事
 * 是一对：哪天给上报器加了后台重试队列，这里就得把顺序闸一起加回来。
 *
 * 按日期挡也不行：往西飞过日界线时本地日会往回走一天，而手表上的圈确实跟着回去了。
 */
export function writeActivity(stored: StoredActivity): Promise<void> {
  return mirror.put(stored);
}

export function readActivityState(): Promise<StoredActivity | null> {
  return mirror.get();
}

/**
 * 在取数出口盖一次「手表那边现在还是不是这一天」。
 *
 * 和充电头 withChargerFreshness 同一套口径：过期是时间的函数，取数时现算，卡片
 * 直接用。跨过午夜之后手表上的圈已经归零，站点手上这份满环说的是昨天 —— 那是这
 * 条数据唯一会「光靠时间流逝就变错」的地方，所以也是唯一要现算的东西。
 */
export function withActivityFreshness(
  payload: ActivityPayload,
  now = Date.now(),
): ActivityPayload {
  return {
    ...payload,
    currentAtSource: localDate(now, payload.secondsFromGMT) === payload.date,
  };
}

export async function getActivitySnapshot(): Promise<ActivityPayload> {
  const stored = await readActivityState();
  // 还没收到过任何上报。交给 statusRoute 变成降级信封，卡片自己不写提示
  if (!stored) throw new AwaitingReport("尚未收到活动圆环上报");

  return withActivityFreshness({
    ...stored.activity,
    pushedAt: stored.receivedAt,
    currentAtSource: true,
  });
}
