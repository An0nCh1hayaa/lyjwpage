"use client";

import { useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";

import { HeroLyrics, HeroLyricsSkeleton } from "@/components/live/hero-lyrics";
import { useLyrics } from "@/hooks/use-lyrics";
import { PLAYBACK_STATE, type MediaItem, type MusicKitInstance } from "@/lib/musickit";
import { catalogItemId } from "@/lib/playing-queue";
import type { LocalNowPlaying } from "@/lib/types";

/**
 * 弹窗里访客正在放那首的同步歌词。
 *
 * 歌词按队列条目的目录 ID 去问 `/api/lyrics?song=`（卡片 hero 问的是主人那首，
 * 这里问的是访客自己放的那首，服务端猜不到，所以由浏览器传）。目录说没词的
 * （`hasLyrics` 为 false）不问；MusicKit 没给这个字段就当有，问一次最多换来一个
 * 「没有」，浏览器那侧只记一小时。
 *
 * HeroLyrics 要的是一个锚点（state / observedAt / positionMs），位置由它自己的
 * 计时器按 lib/track-position 往前推。这里把 MusicKit 的进度每秒抄成一个锚点：
 * 抄的那一刻 observedAt 就是现在，推出来的位置和进度条走的是同一个数。
 * 状态只在这个组件里，不进 Provider —— 每秒一次的更新不该让整棵树跟着重画。
 */
export function PlayerLyrics({
  instance,
  nowPlaying,
  active,
}: {
  instance: MusicKitInstance | null;
  nowPlaying: MediaItem | null;
  /** 只有出过声才显示：没在放的时候队列里的第一首不算「正在唱」 */
  active: boolean;
}) {
  const songId = active ? catalogItemId(nowPlaying?.id) : null;
  const hasLyrics = nowPlaying?.attributes?.hasLyrics ?? true;
  const { lyrics, songwriters, isLoading } = useLyrics(songId, hasLyrics);
  const reduced = useReducedMotion();
  const [anchor, setAnchor] = useState<LocalNowPlaying | null>(null);

  useEffect(() => {
    if (!instance || !songId) return;
    const attributes = nowPlaying?.attributes;
    const read = () => {
      setAnchor({
        source: "apple-music",
        state: instance.playbackState === PLAYBACK_STATE.playing ? "playing" : "paused",
        title: attributes?.name ?? null,
        artist: attributes?.artistName ?? null,
        album: attributes?.albumName ?? null,
        trackId: songId,
        artworkUrl: null,
        positionMs: Math.max(0, (instance.currentPlaybackTime || 0) * 1000),
        durationMs: Math.max(0, (instance.currentPlaybackDuration || 0) * 1000),
        repeatOne: false,
        observedAt: Date.now(),
      });
    };
    read();
    instance.addEventListener("playbackTimeDidChange", read);
    instance.addEventListener("playbackStateDidChange", read);
    return () => {
      instance.removeEventListener("playbackTimeDidChange", read);
      instance.removeEventListener("playbackStateDidChange", read);
    };
  }, [instance, songId, nowPlaying]);

  if (!songId) return null;
  // 没词也没在等：整块不占位。等的时候和 hero 一样先画骨架，免得歌词到了才把弹窗撑高
  if (!lyrics && !isLoading) return null;
  const track = anchor?.trackId === songId ? anchor : null;

  return (
    <div className="mt-3 border-t border-line pt-2">
      {lyrics && track ? (
        <HeroLyrics
          lyrics={lyrics}
          track={track}
          songwriters={songwriters}
          reduced={Boolean(reduced)}
        />
      ) : (
        <HeroLyricsSkeleton />
      )}
    </div>
  );
}
