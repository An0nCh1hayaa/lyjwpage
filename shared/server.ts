import { mirrorKey } from "@/lib/storage";
import type { ServerStatus } from "@/lib/types";

/** 一周。机器重启几天再回来时，卡片该说的是「这是上次那份」，不是「从没收到过」 */
export const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type StoredServer = {
  status: ServerStatus;
  /** 源站收到的时刻 */
  receivedAt: number;
};

export const mirror = mirrorKey<StoredServer>(
  ["server", "host"],
  (state) => state.receivedAt,
  { ttlMs: TTL_MS },
);
