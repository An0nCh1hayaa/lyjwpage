"use client";

import { Pause, Play } from "lucide-react";

import { MINI_ARTWORK_PX, PlayerArtwork } from "@/components/web-player/player-artwork";
import { useWebPlayer } from "@/components/web-player/web-player-provider";
import { PLAYBACK_STATE } from "@/lib/musickit";

/**
 * 页头主题按钮旁的缩略播放器：一张封面加一颗播放 / 暂停。
 * 不放文字 —— 页头右侧那格在手机上很窄，和主题按钮一样只有 32px 高。
 */
export function MiniPlayer() {
  const player = useWebPlayer();

  // 没有 Provider、还没开始放过、或弹窗正开着时不显示
  if (!player || !player.active || player.open) {
    return null;
  }

  const isPlaying = player.playbackState === PLAYBACK_STATE.playing;

  return (
    <div className="paper-card flex h-8 items-center gap-1 rounded-md border border-line-strong bg-surface px-1">
      {/* 封面按钮：点击回到播放器展开页 */}
      <button
        type="button"
        aria-label="打开播放器"
        onClick={player.openDialog}
        className="flex items-center justify-center rounded-sm transition-opacity hover:opacity-80"
      >
        <PlayerArtwork
          artwork={player.item?.artwork ?? null}
          size={MINI_ARTWORK_PX}
          className="rounded-sm"
        />
      </button>

      <button
        type="button"
        aria-label={isPlaying ? "暂停" : "播放"}
        onClick={player.toggle}
        className="p-1 text-muted-foreground transition-colors hover:text-foreground"
      >
        {isPlaying ? (
          <Pause className="size-4" aria-hidden />
        ) : (
          <Play className="size-4" aria-hidden />
        )}
      </button>
    </div>
  );
}
