import { type ResolvedNowPlaying, type StoredWatchingItem } from "@/lib/emby-store";
import { publicAssetUrl } from "@/lib/r2-assets";
import type { WatchingItem } from "@/lib/types";

/**
 * 「最近在看」和「正在播放」拆成两份，因为它们的刷新节奏根本不同：
 * 前者一天可能只变几次，后者跟着播放走。
 * 合成一个端点的话，慢的那半会被快的那半的节奏拖着白跑。
 */
export type WatchingPayload = {
  items: WatchingItem[];
};

export type NowWatchingPayload = {
  /** 此刻播放中的那一条，附带设备与暂停状态 */
  nowPlaying: ResolvedNowPlaying | null;
  /**
   * 播放中那一项的详情。
   *
   * 单独给是因为它不一定在 Resume 列表里（刚开播、或已经看完就会掉出去），
   * 而两个端点各自刷新，服务端没法再像从前那样把它插进列表里返回。
   * 置顶和去重交给页面做 —— 那本来就是展示逻辑。
   */
  current: WatchingItem | null;
};

/** 把存下来的条目里的图片键换成当前部署的公开地址。键还没对应上图就先空着 */
export function resolve(item: StoredWatchingItem, objectKeys: Record<string, string>): WatchingItem {
  const { posterKey, backdropKey, ...rest } = item;
  const posterObjectKey = posterKey ? objectKeys[posterKey] : null;
  const backdropObjectKey = backdropKey ? objectKeys[backdropKey] : null;
  return {
    ...rest,
    poster: posterObjectKey ? publicAssetUrl(posterObjectKey) : null,
    backdrop: backdropObjectKey ? publicAssetUrl(backdropObjectKey) : null,
  };
}

/**
 * 拼装和取数分开：上报那条路上这些东西全在手上（刚规范化好的列表、刚落下的
 * 播放状态），不必等它们写进 Redis 再读回来。条数的默认值只在这里写一遍。
 */
export function watchingPayload(
  items: StoredWatchingItem[],
  objectKeys: Record<string, string>,
  { limit = 8 } = {},
): WatchingPayload {
  return { items: items.slice(0, limit).map((item) => resolve(item, objectKeys)) };
}

export function nowWatchingPayload(
  live: ResolvedNowPlaying | null,
  current: StoredWatchingItem | null,
  objectKeys: Record<string, string>,
): NowWatchingPayload {
  if (!live) return { nowPlaying: null, current: null };
  // 详情比 webhook 晚到一拍很正常（代理下一轮才把这一项推来），对不上就先不给
  return {
    nowPlaying: live,
    current: current?.id === live.itemId ? resolve(current, objectKeys) : null,
  };
}
