import { mirrorKey } from "@/lib/redis";
import type { WatchingItem } from "@/lib/types";

/** 事件之间可能隔很久（一部电影两小时只有首尾两条），保留时间要足够宽 */
export const TTL_MS = 6 * 60 * 60 * 1000;

/**
 * 续播列表和图片映射留得久一些。
 *
 * 它们只在代理有变化时才推，一部剧看完到下一次开播中间可能好几天都没有新推送；
 * 按会话那档 6 小时算的话，页面会在没人看片的日子里空掉。
 */
export const LIBRARY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 播放中的位置状态。
 *
 * 代理有两个触发源：Emby 转发过来的播放事件（开始/暂停/继续/停止），以及它自己
 * 每 2 秒查一次会话 —— 拖动进度条 Emby 不发任何通知，只能查出来。
 */
export type EmbyNowPlaying = {
  itemId: string;
  paused: boolean;
  /** 事件发生时的播放位置 */
  positionTicks: number;
  /** 该条目总时长，0 表示未知 */
  runTimeTicks: number;
  device: string;
  /** 事件到达时刻，毫秒 */
  at: number;
};

/** Redis 为主、进程内存为辅，规则见 lib/redis 的 mirrorKey */
export const mirror = mirrorKey<EmbyNowPlaying>(["emby", "nowPlaying"], (state) => state.at, {
  ttlMs: TTL_MS,
});

/**
 * 存下来的一项，图片位上放的是「图片键」而不是地址。
 *
 * 键到地址的映射单独存（见下面的 images 镜像），落地时不把地址烧进条目里 ——
 * 图片和列表是分两次推来的：列表先到、图片可能还在路上，或者 Redis 被清空后
 * 只需补推图片。地址在读取时才解析，晚到的那批图能把已经存着的列表一起点亮，
 * 不用把整个列表重推一遍。
 */
export type StoredWatchingItem = Omit<WatchingItem, "poster" | "backdrop"> & {
  posterKey: string | null;
  backdropKey: string | null;
};

export const resumeMirror = mirrorKey<{ items: StoredWatchingItem[]; at: number }>(
  ["emby", "resume"],
  (state) => state.at,
  { ttlMs: LIBRARY_TTL_MS },
);

/**
 * 播放中那一项的详情，和 nowPlaying 分开存。
 *
 * 合在一起的话，Emby 的 webhook（它只知道 id、位置和设备）每来一条暂停/继续
 * 就会把代理推来的详情覆盖掉。两份各写各的，读的时候按 itemId 对上即可。
 */
export const currentMirror = mirrorKey<{ item: StoredWatchingItem; at: number }>(
  ["emby", "current"],
  (state) => state.at,
  { ttlMs: TTL_MS },
);

export const imagesMirror = mirrorKey<{ objectKeys: Record<string, string>; at: number }>(
  ["emby", "images"],
  (state) => state.at,
  { ttlMs: LIBRARY_TTL_MS },
);
