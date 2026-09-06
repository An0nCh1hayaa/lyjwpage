import { AwaitingReport } from "@/lib/awaiting-report";
import { getCurrentItem, getImageObjectKeys, getNowPlaying, getResume } from "@/lib/emby-store";
import { type NowWatchingPayload, nowWatchingPayload, type WatchingPayload, watchingPayload } from "@shared/emby";

export async function getWatching(options: { limit?: number } = {}): Promise<WatchingPayload> {
  const stored = await getResume();
  // 还没收到过推送。交给 statusRoute 变成降级信封，前端显示提示
  if (!stored) throw new AwaitingReport("尚未收到 Emby 推送");

  return watchingPayload(stored.items, await getImageObjectKeys(), options);
}

/** 全靠推送，空闲时零上游请求 —— 没在播就只读一次自家存储 */
export async function getNowWatching(): Promise<NowWatchingPayload> {
  const live = await getNowPlaying();
  if (!live) return { nowPlaying: null, current: null };

  return nowWatchingPayload(
    live,
    (await getCurrentItem())?.item ?? null,
    await getImageObjectKeys(),
  );
}
export { type NowWatchingPayload, nowWatchingPayload, type WatchingPayload, watchingPayload } from "@shared/emby";
