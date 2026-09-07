"use client";

import { Pause, Play } from "lucide-react";

import { MINI_ARTWORK_PX, PlayerArtwork } from "@/components/web-player/player-artwork";
import { useWebPlayer } from "@/components/web-player/web-player-provider";
import { PLAYBACK_STATE } from "@/lib/musickit";

/**
 * 页头主题按钮旁的缩略播放器：
 * 手机端（< sm）只展示封面图标，尺寸与主题按钮保持一致（32×32），避免空间拥挤；
 * 桌面端（>= sm）额外展示播放 / 暂停快捷按钮。
 */
export function MiniPlayer() {
  const player = useWebPlayer();

  // 没有 Provider、还没开始放过、或弹窗正开着时不显示
  if (!player || !player.active || player.open) {
    return null;
  }

  const isPlaying = player.playbackState === PLAYBACK_STATE.playing;

  return (
    <div className="paper-card flex size-8 items-center overflow-hidden rounded-md border border-line-strong bg-surface p-0 sm:h-8 sm:w-auto sm:gap-1 sm:p-1">
      {/* 封面按钮：点击回到播放器展开页（优先展示当前正在播放的专辑） */}
      <button
        type="button"
        aria-label="打开播放器"
        onClick={() => {
          if (player.activeItem) {
            player.openWith(player.activeItem);
          } else {
            player.openDialog();
          }
        }}
        className="flex size-full items-center justify-center overflow-hidden transition-opacity hover:opacity-80 sm:size-6 sm:rounded-sm"
      >
        <PlayerArtwork
          artwork={(player.activeItem ?? player.item)?.artwork ?? null}
          size={MINI_ARTWORK_PX}
          className="size-full sm:size-6 sm:rounded-sm"
        />
      </button>

      <button
        type="button"
        aria-label={isPlaying ? "暂停" : "播放"}
        onClick={player.toggle}
        className="hidden p-1 text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
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
