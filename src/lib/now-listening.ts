import { homePodVisibleAt } from "@/lib/homepod-store";
import { offlineByLiveness, type Liveness } from "@/lib/reporter-liveness";
import type { LocalNowPlaying, NowListeningPayload } from "@/lib/types";

/**
 * 暂停超过 10 秒就不再占用音乐 Hero，让下一个实时来源接管。
 *
 * 差值必须用源站的钟减设备 observedAt：浏览器再拿自己的钟去减会跨两个时钟，
 * 偏差超过宽限期就热轮询。见 pickNowListening 的 expiresInMs。
 */
export const MUSIC_PAUSE_GRACE_MS = 10_000;

/** Storage 里的两个候选。不含存活、不选 Hero，所以能进 `'use cache'`。 */
export type NowListeningSnapshot = {
  mac: NowListeningCandidate | null;
  homePod: NowListeningCandidate | null;
  /** Mac 那份快照的源站收到时刻，给 payload.receivedAt 用 */
  macReceivedAt: number;
};

export type NowListeningCandidate = {
  music: LocalNowPlaying;
  receivedAt: number;
  id: string | null;
  link: string | null;
  songId: string | null;
  upcomingSongIds: string[];
  hasLyrics: boolean;
};

function isPausedFresh(music: LocalNowPlaying, now: number) {
  return music.state === "paused" && now - music.observedAt < MUSIC_PAUSE_GRACE_MS;
}

/**
 * 从缓存里的候选现选 Hero。存活和墙上的钟都不能冻进快照。
 *
 * 顺序：Mac 在播 → Mac 暂停未满 10 秒 → HomePod 在播 → HomePod 暂停未满 10 秒。
 */
export function pickNowListening(
  snapshot: NowListeningSnapshot,
  live: Liveness,
  now = Date.now(),
): NowListeningPayload {
  const mac = offlineByLiveness(live, now) ? null : snapshot.mac;
  const homePod =
    snapshot.homePod && homePodVisibleAt(snapshot.homePod, now) ? snapshot.homePod : null;

  const chosen =
    (mac?.music.state === "playing" ? mac : null) ??
    (mac && isPausedFresh(mac.music, now) ? mac : null) ??
    (homePod?.music.state === "playing" ? homePod : null) ??
    (homePod && isPausedFresh(homePod.music, now) ? homePod : null);

  return {
    music: chosen?.music ?? null,
    receivedAt:
      Math.max(
        snapshot.macReceivedAt || live.lastSeenAt || 0,
        snapshot.homePod?.receivedAt ?? 0,
      ) || null,
    idle: !chosen,
    id: chosen?.id ?? null,
    link: chosen?.link ?? null,
    songId: chosen?.songId ?? null,
    upcomingSongIds: chosen?.upcomingSongIds ?? [],
    hasLyrics: chosen?.hasLyrics ?? false,
    expiresInMs:
      chosen?.music.state === "paused"
        ? Math.max(0, MUSIC_PAUSE_GRACE_MS - (now - chosen.music.observedAt))
        : null,
  };
}
