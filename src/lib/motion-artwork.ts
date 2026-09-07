import { ampFetch, AppleUpstreamError, getWebToken } from "@/lib/apple-web-token";
import { get, put } from "@/lib/cache";
import type { AppleMusicParsed } from "@/lib/motion-artwork-url";

/**
 * Apple Music 正方形动态封面（`motionDetailSquare`）解析。
 *
 * 从前是独立的 Cloudflare Worker（am-motion-artwork），现在收编进站点：
 * `/api/motion-artwork` 按 `url` 参数答，不带参数时由服务端按此刻在播那首的链接
 * 自决，少一个要单独部署、单独配 ALLOWED_ORIGINS 的部件。逻辑原样搬来 —— 用从 music.apple.com 网页 JS 里
 * 扒的 web token 打 amp-api，**不用** Mac 上报器推来的那份 MusicKit 凭据：
 * `editorialVideo` 是 amp-api 的扩展属性，公开目录 API 认不认它没有验证过，
 * 而扒来的 token 本来就一分钱凭据不用。token 的扒取、缓存、401 作废在
 * lib/apple-web-token，和歌词那条路共用。
 *
 * 缓存从 Cloudflare 边缘缓存换成 lib/cache（SQLite 为主、进程内存兜底），
 * TTL 沿用 Worker 的约定：**有**动态封面 24 小时，**确认没有** 1 小时 ——
 * 后者短是留给「专辑后来补了动态封面」的翻案窗口。上游出错不写缓存，
 * 只留 5 秒负缓存挡穿透。带参的响应 CDN 也存一份，不带参的 no-store（见
 * app/api/motion-artwork/route.ts）。
 */

/** 所有 JSON 响应共用这一个形状，调用方不用按状态码分路解析 */
export interface MotionResult {
  hasMotion: boolean;
  videoUrl: string | null;
  colors: string[] | null;
  error?: string;
}

/** 「查过了，没有动态封面」。要带 error 时展开它再补一个字段 */
export const NO_MOTION: MotionResult = { hasMotion: false, videoUrl: null, colors: null };

/** 有动态封面的结论不会变，缓存久一点 */
const MOTION_TTL_MS = 24 * 60 * 60 * 1000;
/** 「确认没有」留个翻案窗口：专辑发行后补动态封面的事是有的 */
const NO_MOTION_TTL_MS = 60 * 60 * 1000;
/** 上游报错后，多久之内不再重试 */
const NEGATIVE_TTL_MS = 5_000;

const inflight = new Map<string, Promise<MotionResult>>();

/**
 * 解析一条已经 parse 过的 Apple Music 资源的动态封面。上游异常往上抛，
 * 由路由决定响应形状 —— 抛和「上游明确说没有」不能混成同一个 null。
 *
 * 没走 lib/cache 的 `cached()`：TTL 要按结论分档（有 24h / 没有 1h），
 * 而它一个键只吃一个 TTL。in-flight 去重和 5 秒负缓存照它那套自己搭。
 * 缓存键用解析后的身份而不是原始链接 —— 同一张专辑带不同查询串的链接
 * 该命中同一条。
 */
export async function resolveMotionArtwork(parsed: AppleMusicParsed): Promise<MotionResult> {
  const cacheKey = parsed.albumId
    ? `motion-artwork:v1:${parsed.storefront}:album:${parsed.albumId}`
    : `motion-artwork:v1:${parsed.storefront}:song:${parsed.songId}`;

  const [hit, failure] = await Promise.all([
    get<MotionResult>(cacheKey),
    get<{ message: string }>(`neg:${cacheKey}`),
  ]);
  if (hit !== undefined) return hit;
  if (failure) throw new AppleUpstreamError(failure.message);

  const running = inflight.get(cacheKey);
  if (running) return running;

  const promise = (async () => {
    try {
      const result = await loadMotionArtwork(parsed);
      await put(cacheKey, result, result.hasMotion ? MOTION_TTL_MS : NO_MOTION_TTL_MS);
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await put(`neg:${cacheKey}`, { message: err.message }, NEGATIVE_TTL_MS);
      throw err;
    } finally {
      inflight.delete(cacheKey);
    }
  })();

  inflight.set(cacheKey, promise);
  return promise;
}

async function loadMotionArtwork(parsed: AppleMusicParsed): Promise<MotionResult> {
  const token = await getWebToken();

  let albumId = parsed.albumId;
  // 若为独立 /song/ 链接，通过单曲元数据查找所属专辑 ID
  if (!albumId && parsed.songId) {
    albumId = (await fetchAlbumIdBySong(parsed.storefront, parsed.songId, token)) ?? undefined;
    if (!albumId) return NO_MOTION;
  }
  if (!albumId) return NO_MOTION;

  const motion = await fetchSquareMotionArtwork(parsed.storefront, albumId, token);
  if (!motion) return NO_MOTION;

  return { hasMotion: true, videoUrl: motion.videoUrl, colors: motion.colors };
}

async function fetchAlbumIdBySong(
  storefront: string,
  songId: string,
  token: string,
): Promise<string | null> {
  const json = await ampFetch<{
    data?: Array<{
      relationships?: {
        albums?: {
          data?: Array<{ id?: string }>;
        };
      };
    }>;
  }>(
    `https://amp-api.music.apple.com/v1/catalog/${storefront}/songs/${songId}?include=albums`,
    token,
  );
  return json?.data?.[0]?.relationships?.albums?.data?.[0]?.id ?? null;
}

interface EditorialVideoItem {
  video?: string;
  previewFrame?: {
    bgColor?: string;
    textColor1?: string;
    textColor2?: string;
    textColor3?: string;
    textColor4?: string;
  };
}

async function fetchSquareMotionArtwork(
  storefront: string,
  albumId: string,
  token: string,
): Promise<{ videoUrl: string; colors: string[] | null } | null> {
  const result = await ampFetch<{
    data?: Array<{
      attributes?: {
        editorialVideo?: {
          motionDetailSquare?: EditorialVideoItem;
          motionSquareVideo1x1?: EditorialVideoItem;
        };
      };
    }>;
  }>(
    `https://amp-api.music.apple.com/v1/catalog/${storefront}/albums/${albumId}?extend=editorialVideo`,
    token,
  );

  const videoData = result?.data?.[0]?.attributes?.editorialVideo;
  if (!videoData) return null;

  const squareClip = videoData.motionDetailSquare?.video
    ? videoData.motionDetailSquare
    : videoData.motionSquareVideo1x1;

  if (!squareClip?.video) return null;

  const pf = squareClip.previewFrame;
  const colors = pf
    ? ([pf.bgColor, pf.textColor1, pf.textColor2, pf.textColor3, pf.textColor4].filter(
        Boolean,
      ) as string[])
    : null;

  return {
    videoUrl: squareClip.video,
    colors: colors && colors.length > 0 ? colors : null,
  };
}
