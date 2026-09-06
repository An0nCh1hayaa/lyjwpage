import { connection } from "next/server";

import { NO_MOTION, resolveMotionArtwork, type MotionResult } from "@/lib/motion-artwork";
import { parseAppleMusicUrl } from "@/lib/motion-artwork-url";
import { readHeroLink } from "@/lib/now-listening-read";
import { withRedisScope } from "@/lib/redis";

/**
 * 动态封面解析按需端点：`GET /api/motion-artwork[?url=<Apple Music 链接>]`。
 *
 * 两种问法：
 * - 带 `url`：答那个链接的。网页播放器用 —— 访客点开的是「最近在听」里任意一张
 *   专辑 / 歌单，不一定是 hero 上那张。响应按 URL 可缓存（`public` + `s-maxage`，
 *   CDN 把同一条 URL 的重复请求挡在函数外）：动态封面拿到的只是一个视频地址，
 *   不像歌词那样带订阅身份。
 * - 不带：服务端按卡片 hero 此刻挂的链接自决 —— 在播就是那首目录解析出的 `link`，
 *   闲置退回「最近在听」列表第一条（和 listening-card 选 hero 同一套，见
 *   lib/now-listening-read）。响应随时间变、不随 URL 变，一律 `no-store`。
 *
 * 两种问法响应都带 `link`，浏览器拿它对号（见 hooks/use-motion-artwork）。
 * 上游出错一律 no-store —— 错误缓存住了，token 早换好了、同一个 URL 还是拿不到。
 */

export type MotionNowResponse = MotionResult & { link: string | null };

export async function GET(request: Request) {
  // cacheComponents 下没有 force-dynamic 可写，「每次请求都得跑一遍」由它明说
  await connection();

  /*
   * 挡别家网站借访客浏览器把这条端点当放大器，和歌词同一条：
   * 同源 GET fetch 根本不带 Origin 头，按 Origin 卡会把自己人拒掉。
   * 改看 Sec-Fetch-Site —— 浏览器强制附带、页面脚本改不了：自己页面发的是
   * same-origin，别家网站发的一定是 cross-site，直接拒。地址栏直开是 none，
   * 放行；不带这个头的（curl、老浏览器）也放行。
   */
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return jsonResponse({ link: null, ...NO_MOTION, error: "Origin not allowed" }, 403);
  }

  const requested = new URL(request.url).searchParams.get("url")?.trim() ?? "";
  if (requested) {
    const parsed = parseAppleMusicUrl(requested);
    if (!parsed) {
      return jsonResponse({ link: requested, ...NO_MOTION, error: "Invalid Apple Music URL" }, 400);
    }
    try {
      const result = await withRedisScope(() => resolveMotionArtwork(parsed));
      // 有 24 小时、确认没有 1 小时，和 lib/motion-artwork 里 Redis 那两档同一个尺度
      return jsonResponse({ link: requested, ...result }, 200, result.hasMotion ? 86400 : 3600);
    } catch (error) {
      // 响应体保持通用形状，错误原文只进日志不外带
      console.error("[motion-artwork]", error);
      return jsonResponse({ link: requested, ...NO_MOTION }, 500);
    }
  }

  try {
    return await withRedisScope(async () => {
      const link = await readHeroLink();
      const parsed = link ? parseAppleMusicUrl(link) : null;
      if (!parsed) {
        return jsonResponse({ link, ...NO_MOTION }, 200);
      }
      const result = await resolveMotionArtwork(parsed);
      return jsonResponse({ link, ...result }, 200);
    });
  } catch (error) {
    console.error("[motion-artwork]", error);
    return jsonResponse({ link: null, ...NO_MOTION }, 500);
  }
}

function jsonResponse(data: MotionNowResponse, status = 200, cacheTtl = 0): Response {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control":
        cacheTtl > 0
          ? `public, max-age=${cacheTtl}, s-maxage=${cacheTtl}`
          : "no-store, no-cache, must-revalidate",
    },
  });
}
