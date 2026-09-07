import { currentMirror, type EmbyNowPlaying, imagesMirror, mirror, resumeMirror } from "@shared/emby-store";

/**
 * Emby 的全部状态，一律由 NAS 上的推送代理送进来（reporters/emby-reporter）。
 * 本站一个 Emby 请求都不发 —— 站点将来要跑在 Vercel 上，
 * 那时根本够不着内网里的 Emby。
 */

/** Emby 的 tick 是 100 纳秒，1 毫秒 = 10000 tick */
export const TICKS_PER_MS = 10_000;

export type ResolvedNowPlaying = {
  itemId: string;
  paused: boolean;
  /** 推算到「响应发出时」的进度，0–100；时长未知时为 null */
  progress: number | null;
  device: string;
  /**
   * 响应发出时的播放位置与总时长（毫秒）。给客户端本地继续推算用 ——
   * 播放中途 Emby 不发任何事件，光靠轮询进度条是一跳一跳的。
   * 客户端以「收到这份数据的时刻」为锚点往前走，就不用管两边时钟差。
   */
  positionMs: number | null;
  durationMs: number | null;
};

/**
 * 取当前播放状态，并把进度推算到「此刻」。
 *
 * 推送只在开始/暂停/继续/停止、以及代理发现拖了进度条时才来，中间没有消息。
 * 但我们知道推送发生时的位置和总时长，未暂停时按真实时间往前推即可 ——
 * 进度条不用轮询也能走。
 *
 * 同时兼作兜底：如果推算位置已经超过总时长，说明播完了而「停止」那条事件
 * 没收到（客户端崩了、网络断了），此时按已结束处理，不会一直挂着。
 */
export async function getNowPlaying(): Promise<ResolvedNowPlaying | null> {
  return resolveNowPlaying(await mirror.get());
}

/**
 * 推算部分单拎出来，不带取数。
 *
 * 上报那条路上刚写下去的那份就在手上，用不着等它落库再从 SQLite 读回来 ——
 * 读回来的还可能是写之前的那份。
 */
export function resolveNowPlaying(state: EmbyNowPlaying | null): ResolvedNowPlaying | null {
  if (!state) return null;

  if (state.paused) {
    return {
      itemId: state.itemId,
      paused: true,
      progress: state.runTimeTicks
        ? clampPercent((state.positionTicks / state.runTimeTicks) * 100)
        : null,
      device: state.device,
      positionMs: state.positionTicks / TICKS_PER_MS,
      durationMs: state.runTimeTicks ? state.runTimeTicks / TICKS_PER_MS : null,
    };
  }

  const elapsedTicks = (Date.now() - state.at) * TICKS_PER_MS;
  const projected = state.positionTicks + elapsedTicks;

  if (state.runTimeTicks && projected >= state.runTimeTicks) {
    // 早该播完了却没收到停止事件，当作已结束
    return null;
  }

  return {
    itemId: state.itemId,
    paused: false,
    progress: state.runTimeTicks
      ? clampPercent((projected / state.runTimeTicks) * 100)
      : null,
    device: state.device,
    positionMs: projected / TICKS_PER_MS,
    durationMs: state.runTimeTicks ? state.runTimeTicks / TICKS_PER_MS : null,
  };
}

function clampPercent(value: number) {
  return Math.min(100, Math.max(0, value));
}

export async function getResume() {
  return resumeMirror.get();
}

export async function getCurrentItem() {
  return currentMirror.get();
}

export async function getImageObjectKeys(): Promise<Record<string, string>> {
  return (await imagesMirror.get())?.objectKeys ?? {};
}
export { type EmbyNowPlaying, type StoredWatchingItem } from "@shared/emby-store";
