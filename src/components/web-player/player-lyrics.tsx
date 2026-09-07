"use client";

import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { HeroLyrics, HeroLyricsSkeleton } from "@/components/live/hero-lyrics";
import { useLyrics } from "@/hooks/use-lyrics";
import { PLAYBACK_STATE, type MediaItem, type MusicKitInstance } from "@/lib/musickit";
import { catalogItemId } from "@/lib/playing-queue";
import { trackPositionMs } from "@/lib/track-position";
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
 * 计时器按 lib/track-position 往前推。歌词时间轴独立运行，绝不频繁绑定高频音频时间戳，
 * 仅在关键节点同步：状态变化（播放/暂停）、换歌、主动拖拽进度条 seek、以及严重脱轨时校准。
 */
export function PlayerLyrics({
  instance,
  nowPlaying,
  active,
  seekEvent,
  previewing = false,
}: {
  instance: MusicKitInstance | null;
  nowPlaying: MediaItem | null;
  /** 只有出过声才显示：没在放的时候队列里的第一首不算「正在唱」 */
  active: boolean;
  /** 控制条主动拖拽释放触发的 seek 事件 */
  seekEvent?: { targetMs: number; at: number } | null;
  /** 未登录 30 秒试听时整块不占位、不请求歌词 */
  previewing?: boolean;
}) {
  const songId = active && !previewing ? catalogItemId(nowPlaying?.id) : null;
  const hasLyrics = nowPlaying?.attributes?.hasLyrics ?? true;
  const { lyrics, songwriters, isLoading } = useLyrics(songId, hasLyrics);
  const reduced = useReducedMotion();
  const [anchor, setAnchor] = useState<LocalNowPlaying | null>(null);
  const anchorRef = useRef<LocalNowPlaying | null>(null);

  useEffect(() => {
    anchorRef.current = anchor;
  }, [anchor]);

  // 关键节点 1：用户在控制条主动 seek，立即对齐歌词时钟
  const [prevSeekEvent, setPrevSeekEvent] = useState(seekEvent);
  if (seekEvent !== prevSeekEvent) {
    setPrevSeekEvent(seekEvent);
    if (seekEvent && instance && songId) {
      const attributes = nowPlaying?.attributes;
      setAnchor({
        source: "apple-music",
        state: instance.playbackState === PLAYBACK_STATE.playing ? "playing" : "paused",
        title: attributes?.name ?? null,
        artist: attributes?.artistName ?? null,
        album: attributes?.albumName ?? null,
        trackId: songId,
        artworkUrl: null,
        positionMs: Math.max(0, seekEvent.targetMs),
        durationMs: Math.max(0, (instance.currentPlaybackDuration || 0) * 1000),
        repeatOne: false,
        observedAt: seekEvent.at,
      });
    }
  }

  useEffect(() => {
    if (!instance || !songId) return;
    const attributes = nowPlaying?.attributes;

    const syncAnchor = () => {
      const now = Date.now();
      const posSec = instance.currentPlaybackTime || 0;
      const posMs = Math.max(0, posSec * 1000);
      const isPlaying = instance.playbackState === PLAYBACK_STATE.playing;

      setAnchor({
        source: "apple-music",
        state: isPlaying ? "playing" : "paused",
        title: attributes?.name ?? null,
        artist: attributes?.artistName ?? null,
        album: attributes?.albumName ?? null,
        trackId: songId,
        artworkUrl: null,
        positionMs: posMs,
        durationMs: Math.max(0, (instance.currentPlaybackDuration || 0) * 1000),
        repeatOne: false,
        observedAt: now,
      });
    };

    // 关键节点 2：曲目加载 / 换歌时初始化起点
    syncAnchor();

    // 关键节点 3：播放状态翻转（播放、暂停、等待缓冲）时同步
    const onState = () => syncAnchor();

    // 关键节点 4：仅在发生外部 Seek、单曲循环绕回开头或休眠唤醒（偏差 > 1500ms）时校准
    // 正常播放期间严禁监听音频时间戳更新锚点，歌词时间轴独立向前平滑推进
    const onTime = () => {
      if (!anchorRef.current) return;
      const isPlaying = instance.playbackState === PLAYBACK_STATE.playing;
      if (!isPlaying) return;

      const currentMs = Math.max(0, (instance.currentPlaybackTime || 0) * 1000);
      const estimatedMs = trackPositionMs(anchorRef.current, Date.now());
      const diff = Math.abs(currentMs - estimatedMs);

      if (diff > 1500) {
        syncAnchor();
      }
    };

    instance.addEventListener("playbackStateDidChange", onState);
    instance.addEventListener("playbackTimeDidChange", onTime);
    return () => {
      instance.removeEventListener("playbackStateDidChange", onState);
      instance.removeEventListener("playbackTimeDidChange", onTime);
    };
  }, [instance, songId, nowPlaying]);

  if (!songId || previewing) return null;
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
