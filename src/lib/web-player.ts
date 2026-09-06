import type { QueueOptions } from "@/lib/musickit";
import type { ListeningItem } from "@/lib/types";

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
