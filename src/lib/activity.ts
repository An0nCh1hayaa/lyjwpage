import { AwaitingReport } from "@/lib/awaiting-report";
import { localDate } from "@/lib/freshness";
import type { ActivityPayload } from "@/lib/types";
import { type StoredActivity, mirror } from "@shared/activity";

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
export { type StoredActivity } from "@shared/activity";
