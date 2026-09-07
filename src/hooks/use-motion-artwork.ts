"use client";
import { backendUrl } from "@/lib/backend-url";
import { useEffect, useState } from "react";

export type MotionArtworkResult = {
  hasMotion: boolean;
  videoUrl: string | null;
  colors: string[] | null;
};

const motionCache = new Map<string, MotionArtworkResult>();
const pendingRequests = new Map<string, Promise<MotionArtworkResult | null>>();
/** 不匹配时记录允许重试的时间戳 */
const retryAfter = new Map<string, number>();

/**
 * 动态封面解析在站点自己身上（app/api/motion-artwork），同源相对路径。
 * 按 `url=<链接>` 去问：卡片问的是 hero 那张，网页播放器问的是访客点开的那张，
 * 后者服务端猜不到。响应里带 link 用来对号。
 */
const MOTION_ENDPOINT = "/api/motion-artwork";

/**
 * 校验是否为合法的 Apple Music 资源地址（专辑 / 歌单 / 歌曲），过滤搜索页与空链接。
 */
function isValidAppleMusicUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  return (
    url.startsWith("https://music.apple.com/") &&
    !url.includes("music.apple.com/search")
  );
}

export async function fetchMotionArtwork(
  url: string,
): Promise<MotionArtworkResult | null> {
  if (!isValidAppleMusicUrl(url)) return null;

  if (motionCache.has(url)) {
    return motionCache.get(url)!;
  }

  if (pendingRequests.has(url)) {
    return pendingRequests.get(url)!;
  }

  const promise = (async () => {
    try {
      const response = await fetch(backendUrl(`${MOTION_ENDPOINT}?url=${encodeURIComponent(url)}`));

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as {
        link?: string | null;
        hasMotion: boolean;
        videoUrl: string | null;
        colors: string[] | null;
      };

      const result: MotionArtworkResult = {
        hasMotion: data.hasMotion,
        videoUrl: data.videoUrl,
        colors: data.colors,
      };

      if (data.link !== url) {
        // 服务端快照与浏览器短暂不一致：不对号只挡 5 秒，把有效结果按 data.link 存入备用
        retryAfter.set(url, Date.now() + 5000);
        if (isValidAppleMusicUrl(data.link)) {
          motionCache.set(data.link, result);
        }
        return null;
      }

      retryAfter.delete(url);
      motionCache.set(url, result);
      return result;
    } catch {
      return null;
    } finally {
      pendingRequests.delete(url);
    }
  })();

  pendingRequests.set(url, promise);
  return promise;
}

/**
 * 当 hero 的 Apple Music 链接更新时，请求动态封面 API。
 */
export function useMotionArtwork(url: string | null | undefined): {
  data: MotionArtworkResult | null;
  isLoading: boolean;
} {
  const key = isValidAppleMusicUrl(url) ? url : null;
  /*
   * 结果连着它属于哪个 url 一起存。这样换歌时不用在 effect 里先把状态清一遍
   * ——「旧结果不作数」在渲染时比一下 url 就知道了，少一轮级联渲染。
   */
  const [resolved, setResolved] = useState<{
    url: string;
    result: MotionArtworkResult | null;
  } | null>(null);

  /**
   * 接口不匹配时允许重试。
   * 到期那一刻拨一下 attempt，effect 重跑并重新去问；接口本身失败仍然不重试。
   */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!key || motionCache.has(key)) return;

    if (resolved?.url === key && resolved.result === null) {
      const until = retryAfter.get(key);
      if (until != null && Date.now() < until) {
        const timer = window.setTimeout(
          () => setAttempt((n) => n + 1),
          Math.max(0, until - Date.now()),
        );
        return () => window.clearTimeout(timer);
      }
      if (until == null) {
        // 接口本身失败（非 2xx / 网络错）：不重试
        return;
      }
      retryAfter.delete(key);
    }

    let active = true;
    fetchMotionArtwork(key).then((result) => {
      if (active) setResolved({ url: key, result });
    });

    return () => {
      active = false;
    };
  }, [key, attempt, resolved]);

  if (!key) return { data: null, isLoading: false };

  const cached = motionCache.get(key);
  if (cached) return { data: cached, isLoading: false };

  // 请求回来了但没缓存：接口失败不重试；不匹配时通过 attempt 延迟重试，未命中期间不转圈
  if (resolved?.url === key) return { data: resolved.result, isLoading: false };

  return { data: null, isLoading: true };
}
