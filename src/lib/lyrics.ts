import { readAppleMusicCredentials } from "@/lib/apple-music-credentials";
import { ampFetch, AppleUpstreamError, getWebToken } from "@/lib/apple-web-token";
import { get, put } from "@/lib/cache";
import { parseLyricsTtml, type LyricLine } from "@/lib/lyrics-ttml";

/**
 * 此刻在播那首的同步歌词。
 *
 * Apple 的公开目录 API（api.music.apple.com）不给歌词；歌词只在 amp-api ——
 * 网页播放器自己用的那套内部端点 —— 的 `songs/{id}/lyrics` 上有，而且要**两把
 * 钥匙一起**：扒来的 web token 走 `Authorization`（和动态封面同一份，见
 * lib/apple-web-token），订阅身份走 `Media-User-Token`（Mac 上报器推来的那份
 * MusicKit 凭据里的 music user token）。缺后者时 amp-api 回的不是 401 / 403，
 * 而是和「这首歌没有歌词」**一模一样**的 404 `No related resources`，所以这条
 * 路上的 404 不能直接当成「没有」长期缓存，见下面 NO_LYRICS_TTL_MS。
 *
 * 先要字级（`/syllable-lyrics`），没有再退回行级（`/lyrics`）：字级那份每句带
 * 逐字计时，hero 上那一句按字点亮；不是每首都有，404 就退。解析在 lib/lyrics-ttml。
 */

export type LyricsResult = {
  /** 按 startMs 升序。没有同步歌词（纯文本、或根本没有）时为空数组 */
  lines: LyricLine[];
  /** 词曲作者 / 创作者名单 */
  songwriters?: string[];
  error?: string;
};

export const NO_LYRICS: LyricsResult = { lines: [] };

/** 一首歌的歌词不会变，和曲目链接那条缓存同一个尺度 */
const LYRICS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * 「没有歌词」只缓存一小时。
 *
 * 404 有两种含义：这首歌确实没有同步歌词，或者 Media-User-Token 那一刻不在
 * （Redis 抖一下、上报器重新授权中）。两者在响应上分不开，按一周缓存的话后一种
 * 会把一首明明有词的歌锁死一星期。目录查询那侧的 `hasLyrics` 已经把「确实没有」
 * 的大头挡在了请求之前（见 lib/apple-music 和 hooks/use-lyrics），走到这里的
 * 404 更可能是后者，所以留短。
 */
const NO_LYRICS_TTL_MS = 60 * 60 * 1000;
/** 上游报错后，多久之内不再重试 */
const NEGATIVE_TTL_MS = 5_000;

const inflight = new Map<string, Promise<LyricsResult>>();

function storefront(): string {
  return (process.env.APPLE_MUSIC_STOREFRONT?.trim() || "cn").toLowerCase();
}

/**
 * 取一首歌的歌词。上游异常往上抛，由路由决定响应形状 —— 抛和「上游明确说没有」
 * 不能混成同一个空数组。
 *
 * 没走 lib/cache 的 `cached()`：TTL 要按结论分档（有 7 天 / 没有 1 小时），
 * 而它一个键只吃一个 TTL。in-flight 去重和 5 秒负缓存照动态封面那套。
 */
export async function resolveLyrics(songId: string): Promise<LyricsResult> {
  // 目录 ID 只会是一串数字；路由那边对请求参数查过一道，这里防御性再查一道
  if (!/^\d{1,20}$/.test(songId)) throw new AppleUpstreamError("songId 不是目录 ID");
  const id = songId;
  // v4：多了 songwriters 字段
  const cacheKey = `lyrics:v4:${storefront()}:${id}`;

  const [hit, failure] = await Promise.all([
    get<LyricsResult>(cacheKey),
    get<{ message: string }>(`neg:${cacheKey}`),
  ]);
  if (hit !== undefined) return hit;
  if (failure) throw new AppleUpstreamError(failure.message);

  const running = inflight.get(cacheKey);
  if (running) return running;

  const promise = (async () => {
    try {
      const result = await loadLyrics(id);
      await put(cacheKey, result, result.lines.length ? LYRICS_TTL_MS : NO_LYRICS_TTL_MS);
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

async function loadLyrics(songId: string): Promise<LyricsResult> {
  const credentials = await readAppleMusicCredentials();
  if (!credentials.ok) {
    // 没有订阅身份就别去问：问了也是那个分不清的 404，还会把它缓存成「没有」
    throw new AppleUpstreamError(
      credentials.reason === "redis-unreachable"
        ? "读不到 Apple Music 凭据 —— Redis 连不上"
        : "没有 Mac 上报器推来的 Apple Music 凭据",
    );
  }
  const token = await getWebToken();
  const headers = { "Media-User-Token": credentials.credentials.musicUserToken };

  // 先字级再行级：一首歌两种都有时字级那份带逐字计时；只有行级的歌字级那条 404
  for (const kind of ["syllable-lyrics", "lyrics"] as const) {
    let json: { data?: Array<{ attributes?: { ttml?: string } }> };
    try {
      json = await ampFetch(
        `https://amp-api.music.apple.com/v1/catalog/${storefront()}/songs/${songId}/${kind}`,
        token,
        headers,
      );
    } catch (error) {
      // 404 是 amp-api 说「没有」的方式（或者订阅身份没被认，见文件头）
      if (error instanceof AppleUpstreamError && error.status === 404) continue;
      throw error;
    }
    const ttml = json?.data?.[0]?.attributes?.ttml;
    if (!ttml) continue;
    const { lines, songwriters } = parseLyricsTtml(ttml);
    if (lines.length) return { lines, songwriters };
  }
  return NO_LYRICS;
}
