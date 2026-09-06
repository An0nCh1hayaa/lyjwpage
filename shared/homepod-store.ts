
import { mirrorKey } from "@/lib/redis";
import type { LocalNowPlaying } from "@/lib/types";

export const TTL_MS = 24 * 60 * 60 * 1000;

export type StoredHomePod = {
  music: LocalNowPlaying;
  receivedAt: number;
};

/**
 * Redis 为主、进程内存为辅，规则见 lib/redis 的 mirrorKey。
 *
 * 「内存那份更新就不被 Redis 的旧值盖回去」原来是这里手写的，现在归到工厂里 ——
 * 其它几个 store 有同一个问题，只有这里当初发现了。
 */
export const mirror = mirrorKey<StoredHomePod>(
  ["homepod", "nowPlaying"],
  (state) => state.receivedAt,
  { ttlMs: TTL_MS },
);
