"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ExternalLink, Pause, Play, SkipBack, SkipForward, X } from "lucide-react";

import { DialogButton } from "@/components/live/listen-along-button";
import { Modal } from "@/components/ui/modal";
import { DIALOG_ARTWORK_PX, PlayerArtwork } from "@/components/web-player/player-artwork";
import type { WebPlayer } from "@/hooks/use-web-player";
import { PLAYBACK_STATE } from "@/lib/musickit";
import { catalogItemId } from "@/lib/playing-queue";
import { cn } from "@/lib/utils";
import {
  computePlaylistHeight,
  formatClock,
  PLAYLIST_MAX_HEIGHT_PX,
  queueOptionsFor,
} from "@/lib/web-player";

/** 滑块上会改值的键。松开这些才 seek，别的键（Tab / Escape）路过不算 */
const SEEK_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/**
 * 播放器的展开页。
 *
 * 打开时队列已经在装（见 use-web-player 的 openWith），所以曲目列表登录前就
 * 能看。登录前也能放，只是每首 30 秒试听 —— 控件一律显示，试听这件事在说明
 * 和进度行里标出来。出声只从底栏的 Play、中间那颗播放键或点某一首开始 ——
 * 点封面进来不会自动放。
 */
export function WebPlayerDialog({ player }: { player: WebPlayer }) {
  const titleId = useId();
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [, setIsDragging] = useState(false);

  const isDraggingRef = useRef(false);
  const seekingTargetMsRef = useRef<number | null>(null);
  const seekTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const item = player.item;
  const isStarting = player.status === "starting";
  const isPlaying = player.playbackState === PLAYBACK_STATE.playing;
  const playable = item ? queueOptionsFor(item) !== null : false;
  /** 未授权时放的是 30 秒试听，进度那一行要标出来 */
  const previewing = !player.authorized;

  useEffect(() => {
    return () => {
      if (seekTimeoutRef.current) {
        clearTimeout(seekTimeoutRef.current);
      }
    };
  }, []);

  /**
   * 提交 seek 并保持乐观显示：
   * 在底层音频引擎真正跳转并开始回报新位置前，锁定在目标位置，防止放手瞬间旧时间残影把滑块拽回去。
   */
  const commitSeek = useCallback(
    (targetMs: number) => {
      isDraggingRef.current = false;
      setIsDragging(false);
      seekingTargetMsRef.current = targetMs;
      setPositionMs(targetMs);

      if (seekTimeoutRef.current) {
        clearTimeout(seekTimeoutRef.current);
      }
      seekTimeoutRef.current = setTimeout(() => {
        seekingTargetMsRef.current = null;
      }, 2500);

      void player.seekTo(targetMs).finally(() => {
        const inst = player.instance;
        if (inst && !isDraggingRef.current) {
          const currentMs = Math.max(0, (inst.currentPlaybackTime || 0) * 1000);
          if (
            seekingTargetMsRef.current === targetMs &&
            Math.abs(currentMs - targetMs) <= 1500
          ) {
            seekingTargetMsRef.current = null;
            setPositionMs(currentMs);
          }
        }
      });
    },
    [player],
  );

  /**
   * 进度在这里自己订阅，不进 Provider 的状态：playbackTimeDidChange 每秒一次，
   * 放进 context 会让页头和整张卡片跟着每秒重渲染。
   *
   * 依赖项不含 isDragging，避免拖动开始和结束时频繁注销/重挂载并在首帧触发 onTime 覆盖新位置。
   */
  useEffect(() => {
    const inst = player.instance;
    if (!inst) return;

    const onTime = () => {
      if (isDraggingRef.current) return;

      const currentMs = Math.max(0, (inst.currentPlaybackTime || 0) * 1000);
      const targetMs = seekingTargetMsRef.current;

      if (targetMs !== null) {
        // 正在等待 seek 生效：若底层回报与目标差距大于 1.5 秒，说明仍是跳转前旧时间，坚决不覆盖
        if (Math.abs(currentMs - targetMs) > 1500) {
          return;
        }
        seekingTargetMsRef.current = null;
      }

      setPositionMs(currentMs);

      const dur = (inst.currentPlaybackDuration || 0) * 1000;
      if (dur > 0) {
        setDurationMs(dur);
      } else if (player.nowPlaying?.attributes?.durationInMillis) {
        setDurationMs(player.nowPlaying.attributes.durationInMillis);
      }
    };

    onTime();
    inst.addEventListener("playbackTimeDidChange", onTime);
    return () => {
      inst.removeEventListener("playbackTimeDidChange", onTime);
    };
  }, [player.instance, player.nowPlaying]);

  return (
    <Modal titleId={titleId} onClose={player.closeDialog} className="max-w-md">
      <header className="flex items-center justify-between gap-2 px-4">
        <div className="flex items-center gap-1.5">
          <span id={titleId} className="label-mono text-muted-foreground">
            Web Player
          </span>
          <span className="label-mono text-muted-foreground/60">beta</span>
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={player.closeDialog}
          className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </header>

      <div className="px-4">
        <div className="mt-3 flex items-center gap-3">
          <PlayerArtwork
            artwork={item?.artwork ?? null}
            size={DIALOG_ARTWORK_PX}
            className="rounded-md border border-line"
          />
          <div className="flex min-w-0 flex-1 flex-col justify-center">
            <div className="truncate font-medium">{item?.title}</div>
            <div className="truncate text-sm text-muted-foreground">{item?.artist}</div>
            {/* 当前曲名那一行没有内容时也占位，免得队列装好那一下整块往下跳 */}
            <div className="min-h-5 truncate text-sm text-foreground">
              {player.nowPlaying?.attributes?.name ?? (
                <span className="invisible select-none" aria-hidden>
                  &nbsp;
                </span>
              )}
            </div>
          </div>
        </div>

        {!playable ? (
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            这一项没有可播放的地址。
          </p>
        ) : (
          <>
            {/* 未登录也能放：MusicKit 给每首 30 秒试听。控件照常，只把这件事说清楚 */}
            {!player.authorized ? (
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                未登录只能试听每首 30 秒。登录有效的 Apple Music 订阅后完整播放；站点不转发音频、储存凭据。
              </p>
            ) : null}

            <div className="mt-3">
              <input
                type="range"
                aria-label="播放进度"
                min={0}
                max={durationMs > 0 ? durationMs : 1000}
                step={1000}
                value={Math.min(positionMs, durationMs > 0 ? durationMs : 1000)}
                onPointerDown={() => {
                  isDraggingRef.current = true;
                  setIsDragging(true);
                }}
                onChange={(e) => {
                  isDraggingRef.current = true;
                  setIsDragging(true);
                  setPositionMs(Number(e.target.value));
                }}
                onPointerUp={(e) => {
                  commitSeek(Number((e.target as HTMLInputElement).value));
                }}
                onPointerCancel={(e) => {
                  commitSeek(Number((e.target as HTMLInputElement).value));
                }}
                onKeyUp={(e) => {
                  // 只认真的在挪滑块的键：Tab 走开、Escape 关窗也会经过这里，
                  // 那时 seek 一下等于把正在放的歌拽回滑块当前的整秒
                  if (!SEEK_KEYS.has(e.key)) return;
                  commitSeek(Number((e.target as HTMLInputElement).value));
                }}
                className="w-full cursor-pointer accent-live"
              />
              <div className="label-mono flex justify-between text-muted-foreground tabular-nums">
                <span>{formatClock(positionMs)}</span>
                {/* 试听时总长是 0:30，前面点明，免得以为整首就这么短 */}
                <span>
                  {previewing ? "试听 · " : null}
                  {formatClock(durationMs)}
                </span>
              </div>
            </div>

            <div className="mt-2 flex items-center justify-center gap-6">
              <button
                type="button"
                aria-label="上一首"
                disabled={isStarting}
                onClick={player.previous}
                className="p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                <SkipBack className="size-4" aria-hidden />
              </button>
              {/* 还没出声时 toggle 走的是 play：装好的队列从第一首开始 */}
              <button
                type="button"
                aria-label={isPlaying ? "暂停" : "播放"}
                disabled={isStarting}
                onClick={player.toggle}
                className="p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                {isPlaying ? (
                  <Pause className="size-5" aria-hidden />
                ) : (
                  <Play className="size-5" aria-hidden />
                )}
              </button>
              <button
                type="button"
                aria-label="下一首"
                disabled={isStarting}
                onClick={player.next}
                className="p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                <SkipForward className="size-4" aria-hidden />
              </button>
            </div>

            {/* 队列登录前就显示：有缓存或已装载时，打开弹窗前就计算好高度，防止跳动 */}
            {(() => {
              const count = player.queue.length;
              const hasQueue = count > 0;
              const targetHeight = hasQueue
                ? computePlaylistHeight(count)
                : isStarting
                  ? PLAYLIST_MAX_HEIGHT_PX
                  : undefined;

              return (
                <div
                  className="mt-3 max-h-56 overflow-y-auto border-t border-line"
                  style={targetHeight != null ? { height: `${targetHeight}px` } : undefined}
                >
                  {!hasQueue ? (
                    isStarting ? (
                      <div aria-hidden>
                        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                          <div
                            key={i}
                            className="flex h-8 animate-pulse items-center gap-2 px-1 py-1.5"
                          >
                            <div className="h-3.5 w-5 rounded bg-muted" />
                            <div className="h-3.5 flex-1 rounded bg-muted" />
                            <div className="h-3.5 w-8 rounded bg-muted" />
                          </div>
                        ))}
                      </div>
                    ) : null
                  ) : (
                    player.queue.map((song, index) => {
                      const isCurrent =
                        catalogItemId(song.id) === catalogItemId(player.nowPlaying?.id);
                      return (
                        <button
                          key={song.id ?? index}
                          type="button"
                          onClick={() => player.playAt(index)}
                          className="flex h-8 w-full items-center gap-2 px-1 py-1.5 text-left text-sm transition-colors hover:bg-surface-hover"
                        >
                          <span className="label-mono w-5 shrink-0 text-muted-foreground">
                            {index + 1}
                          </span>
                          <span
                            className={cn(
                              "min-w-0 flex-1 truncate",
                              isCurrent && "font-medium text-live",
                            )}
                          >
                            {song.attributes?.name ?? "未知曲目"}
                          </span>
                          <span className="label-mono shrink-0 text-muted-foreground">
                            {formatClock(song.attributes?.durationInMillis ?? 0)}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              );
            })()}
          </>
        )}

        {player.error ? (
          <p className="mt-2 text-sm text-muted-foreground">{player.error}</p>
        ) : null}
      </div>

      <div className="mt-4 flex border-t border-line">
        {!playable ? null : player.active ? (
          <DialogButton onClick={player.stop}>Stop</DialogButton>
        ) : (
          // 点封面只是打开这张卡片，真正出声从这里（或中间那颗播放键）开始
          <DialogButton disabled={isStarting} onClick={player.play}>
            {isStarting ? "Loading..." : "Play"}
          </DialogButton>
        )}

        {/* 登录入口和播放键并排：未登录也能试听，登录是「换成整首」而不是「才能放」 */}
        {playable && !player.authorized ? (
          <>
            <div className="w-px self-stretch bg-line" aria-hidden />
            <DialogButton disabled={isStarting} onClick={player.signIn}>
              {isStarting ? "Connecting..." : "Sign in"}
            </DialogButton>
          </>
        ) : null}

        {/* 跳 Apple Music 的入口在这里，列表和 hero 上不再直接外跳 */}
        {item?.link ? (
          <>
            {playable ? <div className="w-px self-stretch bg-line" aria-hidden /> : null}
            <a
              href={item.link}
              target="_blank"
              rel="noreferrer noopener"
              className="label-mono inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 py-2.5 text-center text-foreground transition-colors hover:bg-surface-hover"
            >
              <span>Apple Music</span>
              <ExternalLink className="size-3 shrink-0" aria-hidden />
            </a>
          </>
        ) : null}

        {player.authorized ? (
          <>
            <div className="w-px self-stretch bg-line" aria-hidden />
            <DialogButton
              onClick={() => {
                player.logout();
                player.closeDialog();
              }}
            >
              Sign out
            </DialogButton>
          </>
        ) : null}
      </div>
    </Modal>
  );
}
