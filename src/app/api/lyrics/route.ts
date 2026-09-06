import { connection } from "next/server";

import { resolveLyrics, type LyricsResult } from "@/lib/lyrics";
import { readNowListening } from "@/lib/now-listening-read";
import { withRedisScope } from "@/lib/redis";

/**
 * 同步歌词按需端点：`GET /api/lyrics[?song=<目录曲目 ID>]`。
 *
 * 两种问法：
 * - 带 `song`：答那一首。网页播放器用 —— 访客在自己那边放专辑里任意一首，
 *   服务端的「此刻在播」快照说的是主人的歌，帮不上他。响应按 URL 可缓存
 *   （`private`，只许这一个浏览器留，不进 CDN：这是拿我的订阅身份换来的整首
 *   正文，共享缓存会把一次放行的响应原样发给之后任何人）。
 * - 不带：站点按此刻在播那首自己决定去取哪首（卡片 hero 用），响应随时间变、
 *   不随 URL 变，一律 `no-store`。快照说 `hasLyrics` 为 false 时直接答空 ——
 *   目录已经说了没有，问 amp-api 也是 404，还会占一条「没有」的缓存。
 *
 * 两种问法响应都带 `songId`，浏览器拿它对号（见 hooks/use-lyrics）。
 *
 * 从前带参那版还有一道「只答此刻在播和排在后面那几首」的白名单，现在**没有**：
 * 网页播放器要放的是整张专辑、任何一首，名单圈不住。留下的门只有下面那道
 * Sec-Fetch-Site —— 别家网站借访客浏览器来问会被拒，同源页面和地址栏直开放行。
 * 这等于把「任意目录 ID 换歌词」开给了任何能直接打这条 URL 的人，是明知的取舍。
 */

export type LyricsNowResponse = LyricsResult & { songId: string | null };

export async function GET(request: Request) {
  // cacheComponents 下没有 force-dynamic 可写，「每次请求都得跑一遍」由它明说
  await connection();

  /*
   * 挡别家网站借访客浏览器把这条端点当放大器，和动态封面同一条：
   * 同源 GET fetch 根本不带 Origin 头，按 Origin 卡会把自己人拒掉。
   * 改看 Sec-Fetch-Site —— 浏览器强制附带、页面脚本改不了：自己页面发的是
   * same-origin，别家网站发的一定是 cross-site，直接拒。地址栏直开是 none，
   * 放行；不带这个头的（curl、老浏览器）也放行。
   */
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return jsonResponse({ songId: null, lines: [], error: "Origin not allowed" }, 403);
  }

  const requested = new URL(request.url).searchParams.get("song")?.trim() ?? "";
  if (requested) {
    if (!/^\d{1,20}$/.test(requested)) {
      return jsonResponse(
        { songId: null, lines: [], error: 'Invalid "song" query parameter' },
        400,
      );
    }
    try {
      const result = await withRedisScope(() => resolveLyrics(requested));
      // 有词 7 天、没有 1 小时，和 lib/lyrics 里 Redis 那两档同一个尺度
      return jsonResponse(
        { songId: requested, ...result },
        200,
        result.lines.length ? 7 * 86400 : 3600,
      );
    } catch (error) {
      // 响应体保持通用形状，错误原文只进日志不外带
      console.error("[lyrics]", error);
      return jsonResponse({ songId: requested, lines: [] }, 500);
    }
  }

  try {
    return await withRedisScope(async () => {
      const now = await readNowListening();
      if (!now || !now.songId) {
        return jsonResponse({ songId: null, lines: [] }, 200);
      }
      if (!now.hasLyrics) {
        return jsonResponse({ songId: now.songId, lines: [] }, 200);
      }
      const result = await resolveLyrics(now.songId);
      return jsonResponse({ songId: now.songId, ...result }, 200);
    });
  } catch (error) {
    console.error("[lyrics]", error);
    return jsonResponse({ songId: null, lines: [] }, 500);
  }
}

function jsonResponse(data: LyricsNowResponse, status = 200, cacheTtl = 0): Response {
  return Response.json(data, {
    status,
    headers: {
      // private：只许这一个浏览器留，共享缓存（CDN、代理）一律不存，理由见文件头
      "Cache-Control":
        cacheTtl > 0 ? `private, max-age=${cacheTtl}` : "no-store, no-cache, must-revalidate",
    },
  });
}
