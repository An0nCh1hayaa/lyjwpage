import {
  fetchDeveloperToken,
  type MediaItem,
  type MusicKitInstance,
  type QueueOptions,
} from "@/lib/musickit";
import type { ListeningItem } from "@/lib/types";

export const PLAYLIST_ROW_HEIGHT_PX = 32;
export const PLAYLIST_PADDING_Y_PX = 12; // py-1.5 (上下各 6px 内边距)
export const PLAYLIST_BORDER_TOP_PX = 1; // border-t (1px 上边框)
export const PLAYLIST_EXTRA_HEIGHT_PX = PLAYLIST_PADDING_Y_PX + PLAYLIST_BORDER_TOP_PX; // 13px
export const PLAYLIST_MAX_VISIBLE_ROWS = 7;
export const PLAYLIST_MAX_HEIGHT_PX =
  PLAYLIST_MAX_VISIBLE_ROWS * PLAYLIST_ROW_HEIGHT_PX + PLAYLIST_EXTRA_HEIGHT_PX; // 237px (14.8125rem)

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
 * 根据曲目数量计算歌单列表容器的目标高度（包含上下内边距与上边框）。
 */
export function computePlaylistHeight(itemCount: number): number {
  if (itemCount <= 0) return 0;
  return Math.min(
    PLAYLIST_MAX_HEIGHT_PX,
    itemCount * PLAYLIST_ROW_HEIGHT_PX + PLAYLIST_EXTRA_HEIGHT_PX,
  );
}

/**
 * 将歌单滚动距离吸附到最近的曲目整行（32px 的整数倍），保证停滚时曲目始终与上下边框对齐。
 */
export function snapPlaylistScrollTop(scrollTop: number, maxScroll: number): number {
  if (maxScroll <= 0) return 0;
  const target = Math.round(scrollTop / PLAYLIST_ROW_HEIGHT_PX) * PLAYLIST_ROW_HEIGHT_PX;
  return Math.min(maxScroll, Math.max(0, target));
}

/**
 * 检查本地存储中是否有 Apple MusicKit 写入的持久化用户令牌（Music User Token）。
 * 用户通过 MusicKit 登录后，令牌会保存在 localStorage 中（如 music.u、music.musicUserToken 等）；
 * 退出登录时 MusicKit 会清除该项。
 */
export function hasPersistedMusicUserToken(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const storage = window.localStorage;
    if (!storage) return false;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key) continue;
      const lower = key.toLowerCase();
      if (lower.startsWith("music.") || lower.includes("musickit") || lower.includes("usertoken")) {
        const val = storage.getItem(key);
        // 排除简短配置项（如 storefront "cn" 或开关 "true"），有效用户令牌通常为长字符串
        if (val && val.length > 20) {
          return true;
        }
      }
    }
  } catch {
    // 隐私模式或无权限访问 localStorage 时安全忽略
  }
  return false;
}

type AuthListener = () => void;
const authListeners = new Set<AuthListener>();
let authSnapshot: boolean | null = null;

/**
 * 获取客户端当前授权状态快照：
 * 若已有内存状态（实例检验结果或用户操作），优先使用；
 * 否则直接检查 localStorage 中是否有持久化的用户令牌，使打开弹窗的首帧即可识别已登录。
 */
export function getMusicAuthSnapshot(): boolean {
  if (authSnapshot !== null) return authSnapshot;
  return hasPersistedMusicUserToken();
}

/**
 * 服务端渲染快照，固定返回 false 避免 hydration 错位。
 */
export function getMusicAuthServerSnapshot(): boolean {
  return false;
}

/**
 * 更新授权状态快照并通知订阅者（如 UI 组件与 hook）。
 */
export function setMusicAuthSnapshot(authorized: boolean): void {
  if (authSnapshot === authorized) return;
  authSnapshot = authorized;
  for (const listener of authListeners) {
    listener();
  }
}

/**
 * 订阅授权状态变化（包括跨标签页 storage 事件）。
 */
export function subscribeMusicAuth(listener: AuthListener): () => void {
  authListeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key && (e.key.toLowerCase().startsWith("music.") || e.key.toLowerCase().includes("usertoken"))) {
      setMusicAuthSnapshot(hasPersistedMusicUserToken());
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    authListeners.delete(listener);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

export function resetMusicAuthStateForTesting(): void {
  authSnapshot = null;
  authListeners.clear();
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
 * 根据「最近在听」条目的链接和 ID 生成 Apple Music Catalog API 的曲目列表请求路径。
 * 格式如: /v1/catalog/{storefront}/albums/{id}/tracks 或 /v1/catalog/{storefront}/playlists/{id}/tracks。
 * 电台或无法解析的链接返回 null。
 */
export function catalogTracksPathFor(
  item: Pick<ListeningItem, "id" | "link">,
  defaultStorefront = "cn",
): string | null {
  if (!item.link) return null;

  let parsed: URL;
  try {
    parsed = new URL(item.link);
  } catch {
    return null;
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  const kindIdx = segments.findIndex(
    (segment) =>
      segment === "album" ||
      segment === "playlist" ||
      segment === "albums" ||
      segment === "playlists",
  );
  if (kindIdx < 0) return null;

  let storefront = defaultStorefront;
  if (kindIdx > 0 && /^[a-z]{2}(?:-[a-z]{2})?$/i.test(segments[0])) {
    storefront = segments[0].toLowerCase();
  }

  const rawKind = segments[kindIdx].toLowerCase();
  const kind = rawKind.startsWith("album") ? "albums" : "playlists";
  const id = item.id || segments[segments.length - 1];
  if (!id) return null;

  return `/v1/catalog/${storefront}/${kind}/${id}/tracks`;
}

/**
 * 获取指定专辑或歌单的完整曲目列表（只读，完全不影响底层的音频播放流）。
 * 优先使用已存在的 MusicKit 实例的 api.music，或使用公开开发者令牌直接发起请求。
 */
export async function fetchCatalogTracks(
  item: Pick<ListeningItem, "id" | "link">,
  inst?: MusicKitInstance | null,
): Promise<MediaItem[]> {
  const path = catalogTracksPathFor(item, inst?.storefrontId);
  if (!path) return [];

  // 1. 如果已有实例且暴露了 api.music，优先复用实例的内置请求逻辑
  if (inst?.api?.music) {
    try {
      const res = await inst.api.music(path);
      const raw = res?.data;
      const data =
        raw && typeof raw === "object" && "data" in raw && Array.isArray(raw.data)
          ? raw.data
          : Array.isArray(raw)
            ? raw
            : null;
      if (data && data.length > 0) {
        return data as MediaItem[];
      }
    } catch {
      // 实例请求异常时回退到直接 fetch
    }
  }

  // 2. 回退到直接请求 Apple Music Catalog API（只需 developer token，无需用户令牌）
  try {
    const token = await fetchDeveloperToken();
    const res = await fetch(`https://api.music.apple.com${path}`, {
      headers: {
        Authorization: `Bearer ${token.token}`,
      },
    });
    if (res.ok) {
      const body = (await res.json()) as { data?: MediaItem[] };
      if (Array.isArray(body?.data)) {
        return body.data;
      }
    }
  } catch {
    // 忽略网络或凭据异常，调用方处理空列表
  }

  return [];
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

/**
 * 从 MusicKit 实例的队列中提取用户添加的曲目，排除 Apple Music 自动推荐追加的 Autoplay 相似歌曲。
 */
export function filterUserQueueItems(inst: MusicKitInstance | null | undefined): MediaItem[] {
  if (!inst?.queue) return [];
  const queue = inst.queue;
  if (Array.isArray(queue.userAddedItems) && queue.userAddedItems.length > 0) {
    return queue.userAddedItems;
  }
  const items = queue.items ?? [];
  return items.filter((item) => !item.isAutoplay);
}
