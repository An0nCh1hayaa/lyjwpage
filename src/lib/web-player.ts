import type { MediaItem, QueueOptions } from "@/lib/musickit";
import type { ListeningItem } from "@/lib/types";

export const PLAYLIST_ROW_HEIGHT_PX = 32;
export const PLAYLIST_MAX_HEIGHT_PX = 224; // 14rem (max-h-56)

/**
 * 会话期间的歌单缓存：key 为专辑/歌单 ID，value 为曲目列表。
 * 用户切换不同专辑时保留已拿到的曲目，再次打开时直接命中缓存秒开，并在打开前计算好高度，避免高度跳动。
 */
const playlistCache = new Map<string, MediaItem[]>();

export function getCachedPlaylist(id: string | null | undefined): MediaItem[] | undefined {
  if (!id) return undefined;
  return playlistCache.get(id);
}

export function setCachedPlaylist(id: string, items: MediaItem[]): void {
  if (!id || items.length === 0) return;
  playlistCache.set(id, items);
}

export function clearPlaylistCache(): void {
  playlistCache.clear();
}

/**
 * 根据曲目数量计算歌单列表容器的目标高度。
 */
export function computePlaylistHeight(itemCount: number): number {
  if (itemCount <= 0) return 0;
  return Math.min(PLAYLIST_MAX_HEIGHT_PX, itemCount * PLAYLIST_ROW_HEIGHT_PX);
}

/**
 * 把「最近在听」的一个条目变成 MusicKit `setQueue` 的参数。
 *
 * 列表条目没有 type 字段（契约里只有 id 和 link），所以按链接路径判断资源种类；
 * 线上实测专辑 id 与链接末段一致，歌单 id 形如 `pl.u-…` 也一致。
 */
export function queueOptionsFor(item: Pick<ListeningItem, "id" | "link">): QueueOptions | null {
  if (!item.link) return null;

  let parsed: URL;
  try {
    parsed = new URL(item.link);
  } catch {
    return null;
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  const kind = segments.find(
    (segment): segment is "album" | "playlist" | "station" =>
      segment === "album" || segment === "playlist" || segment === "station",
  );

  if (kind) {
    const id = item.id || segments[segments.length - 1];
    return { [kind]: id };
  }

  return { url: item.link };
}

/**
 * 播放器上的时间格式化：负数和 NaN 当 0；超过一小时 h:mm:ss，否则 m:ss（秒补两位）。
 */
export function formatClock(milliseconds: number): string {
  if (Number.isNaN(milliseconds) || milliseconds <= 0) {
    return "0:00";
  }

  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const secondsStr = String(seconds).padStart(2, "0");
  if (hours > 0) {
    const minutesStr = String(minutes).padStart(2, "0");
    return `${hours}:${minutesStr}:${secondsStr}`;
  }

  return `${minutes}:${secondsStr}`;
}

/**
 * 仅当当前装载完成的专辑 ID 与目标条目 ID 一致时，才认为队列有效。
 * 用于防止在切换专辑或装载期间，旧专辑的播放列表和当前曲目遗留在弹窗中。
 */
export function resolveVisibleQueue<T>(
  loadedAlbumId: string | null | undefined,
  currentAlbumId: string | null | undefined,
  queue: T[],
): T[] {
  if (!loadedAlbumId || !currentAlbumId || loadedAlbumId !== currentAlbumId) {
    return [];
  }
  return queue;
}
