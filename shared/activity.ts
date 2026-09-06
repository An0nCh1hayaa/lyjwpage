import { mirrorKey } from "@/lib/redis";
import type { ActivityStatus } from "@/lib/types";

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
export const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type StoredActivity = {
  activity: ActivityStatus;
  /** 源站收到的时刻 */
  receivedAt: number;
};

export const mirror = mirrorKey<StoredActivity>(
  ["activity", "today"],
  (state) => state.receivedAt,
  { ttlMs: TTL_MS },
);
