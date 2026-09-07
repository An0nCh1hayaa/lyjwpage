"use client";
import { backendUrl } from "@/lib/backend-url";
import { useEffect, useState } from "react";

import type { LyricLine } from "@/lib/lyrics-ttml";

/**
 * 此刻那首的同步歌词，和 use-motion-artwork 同一个形状：按键存一份模块级缓存，
 * 换歌时不用先清状态 —— 结果连着它属于哪首一起存，渲染时比一下键就知道旧的
 * 不作数。
 *
 * 按 `song=<目录曲目 ID>` 去问：卡片 hero 问的是此刻在播那首，网页播放器问的是
 * 访客自己正在放的那首 —— 后者服务端的快照说不了，所以由浏览器传。响应里带
 * `songId` 用来对号；不对号只挡 5 秒（短暂不一致），并把返回的结果按响应的
 * songId 存进缓存备用。
 *
 * 键是目录曲目 ID（卡片传的是闩住的那份，见 listening-card 的 lookupLatch；
 * 播放器传的是 MusicKit 队列条目的 ID）。只在目录说 `hasLyrics` 时才问。
 */

const LYRICS_ENDPOINT = "/api/lyrics";
/**
 * 响应形状的版本，拼进查询串。路由不看它，它只是浏览器缓存的键的一部分：
 * 带参的响应允许浏览器和 CDN 留 7 天，形状变了而 URL 不变
 * 的话，之前来过的访客整整一周拿到的都是旧形状。改了 LyricsResult 的形状就把
 * 这个数加一。v4：响应多了 songId（09-03 到 09-07 之间不传参那版留下的 v3 缓存
 * 没有它，对号会永远失败）。
 */
const LYRICS_FORMAT = 4;

/**
 * 「没有」只记一小时，和服务端那条负缓存同一个尺度（lib/lyrics 的
 * NO_LYRICS_TTL_MS）。服务端的 404 分不清「这首没词」和「订阅身份那一刻没被认」，
 * 所以它只把「没有」留一小时；浏览器这边要是把空数组永久记住，一个开着不动的
 * 页面就会在凭据恢复之后仍旧对这首歌只显示艺人名，直到整页刷新。
 */
const EMPTY_TTL_MS = 60 * 60 * 1000;
/**
 * 接口没答上来（非 2xx、网络断）只挡几秒，和服务端那条 5 秒负缓存一个尺度。
 * 这不是「没有歌词」，是「这会儿问不到」，记一小时等于把上游抖一下放大成整首歌
 * 都没词。
 */
const FAILURE_TTL_MS = 5_000;

export type CachedLyricsData = {
  lines: LyricLine[];
  songwriters?: string[];
};

/** 首屏快照可能落后于实时状态，必须携带歌词所属曲目。 */
export type LyricsFallback = CachedLyricsData & { songId: string };

/** 有词的一首歌不会变，整个页面生命周期内只问一次 */
const lyricsCache = new Map<string, CachedLyricsData>();
/** 问过但没有（或接口失败）的，记到什么时候为止 */
const emptyUntil = new Map<string, number>();
const pending = new Map<string, Promise<CachedLyricsData | null>>();

function cachedLyrics(songId: string): CachedLyricsData | null | undefined {
  const hit = lyricsCache.get(songId);
  if (hit) return hit;
  const until = emptyUntil.get(songId);
  if (until != null && Date.now() < until) return null;
  return undefined;
}

async function fetchLyrics(songId: string): Promise<CachedLyricsData | null> {
  const known = cachedLyrics(songId);
  if (known !== undefined) return known;
  const running = pending.get(songId);
  if (running) return running;

  const promise = (async () => {
    try {
      const response = await fetch(
        backendUrl(`${LYRICS_ENDPOINT}?song=${encodeURIComponent(songId)}&format=${LYRICS_FORMAT}`),
      );
      if (!response.ok) {
        emptyUntil.set(songId, Date.now() + FAILURE_TTL_MS);
        return null;
      }
      const data = (await response.json()) as {
        songId?: string | null;
        lines?: LyricLine[];
        songwriters?: string[];
      };
      const lines = Array.isArray(data.lines) ? data.lines : [];
      const payload: CachedLyricsData = {
        lines,
        songwriters:
          Array.isArray(data.songwriters) && data.songwriters.length
            ? data.songwriters
            : undefined,
      };

      // 服务端快照和浏览器短暂不一致：不对号只挡 5 秒，把返回结果按 data.songId 预热进缓存
      if (data.songId !== songId) {
        emptyUntil.set(songId, Date.now() + FAILURE_TTL_MS);
        if (data.songId && lines.length) {
          lyricsCache.set(data.songId, payload);
        }
        return null;
      }

      if (lines.length) {
        lyricsCache.set(songId, payload);
        return payload;
      }
      // 服务端明确说了「没有」（可能是没词，也可能是订阅身份那一刻没被认）
      emptyUntil.set(songId, Date.now() + EMPTY_TTL_MS);
      return null;
    } catch {
      emptyUntil.set(songId, Date.now() + FAILURE_TTL_MS);
      return null;
    } finally {
      pending.delete(songId);
    }
  })();

  pending.set(songId, promise);
  return promise;
}

export type UseLyricsResult = {
  lyrics: LyricLine[] | null;
  songwriters?: string[];
  isLoading: boolean;
};

/**
 * 有同步歌词就是非空数组；没有（目录说没有、接口失败、还没回来）一律 null，
 * 调用方退回艺人名那一行。同时返回 isLoading，便于宽屏模式在数据加载期间
 * 提前规划双列占位，避免歌词到位后布局跳动。
 */
export function useLyrics(
  songId: string | null,
  hasLyrics: boolean,
  initialData?: LyricsFallback | null,
): UseLyricsResult {
  const key = songId && hasLyrics ? songId : null;
  const initialSongData = key && initialData?.songId === key ? initialData : null;

  // 首屏若带了当前曲目的歌词数据，直接预热进模块级内存缓存，避免首屏触发额外网络请求
  if (key && initialSongData?.lines.length && !lyricsCache.has(key)) {
    lyricsCache.set(key, initialSongData);
  }

  const [resolved, setResolved] = useState<{
    songId: string;
    data: CachedLyricsData | null;
  } | null>(() => {
    if (!key || !initialSongData?.lines.length) return null;
    return { songId: key, data: initialSongData };
  });

  /**
   * 负缓存到期要能自己再问一次。
   *
   * 同一首一直放着时 `key` 不变，effect 不会重跑，emptyUntil 过了期也没人发现 ——
   * 5 秒那档就白设了：开头一次网络抖动，整首歌都不会再问。到期那一刻拨一下
   * `attempt`，effect 重跑，cachedLyrics 已经不认那条过期的负缓存，于是重新去问。
   */
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!key) return;
    const known = cachedLyrics(key);
    if (known !== undefined) {
      if (known !== null) return;
      const until = emptyUntil.get(key);
      if (until == null) return;
      const timer = window.setTimeout(
        () => setAttempt((n) => n + 1),
        Math.max(0, until - Date.now()),
      );
      return () => window.clearTimeout(timer);
    }

    let active = true;
    fetchLyrics(key).then((data) => {
      if (!active) return;
      setResolved({ songId: key, data });
      // 没取到：负缓存刚写下，让 effect 再跑一遍，走上面那个分支把到期的闹钟上好
      if (data === null) setAttempt((n) => n + 1);
    });

    return () => {
      active = false;
    };
    // attempt 只为在负缓存到期那一刻重跑一遍，effect 本身不读它
  }, [key, attempt]);

  if (!key) return { lyrics: null, isLoading: false };

  const known = cachedLyrics(key);
  const data = known !== undefined ? known : resolved?.songId === key ? resolved.data : null;
  const isLoading = known === undefined && resolved?.songId !== key;

  return {
    lyrics: data?.lines && data.lines.length ? data.lines : null,
    songwriters: data?.songwriters,
    isLoading,
  };
}
