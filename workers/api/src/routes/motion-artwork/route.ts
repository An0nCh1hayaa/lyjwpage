
import { NO_MOTION, resolveMotionArtwork, type MotionResult } from "@/lib/motion-artwork";
import { parseAppleMusicUrl } from "@/lib/motion-artwork-url";
import { readHeroLink } from "@/lib/now-listening-read";
import { withStorageScope } from "@/lib/storage";


export type MotionNowResponse = MotionResult & { link: string | null };

export async function GET(request: Request) {


  const requested = new URL(request.url).searchParams.get("url")?.trim() ?? "";
  if (requested) {
    const parsed = parseAppleMusicUrl(requested);
    if (!parsed) {
      return jsonResponse({ link: requested, ...NO_MOTION, error: "Invalid Apple Music URL" }, 400);
    }
    try {
      const result = await withStorageScope(() => resolveMotionArtwork(parsed));
      // 有 24 小时、确认没有 1 小时，和 lib/motion-artwork 里 SQLite 那两档同一个尺度
      return jsonResponse({ link: requested, ...result }, 200, result.hasMotion ? 86400 : 3600);
    } catch (error) {
      // 响应体保持通用形状，错误原文只进日志不外带
      console.error("[motion-artwork]", error);
      return jsonResponse({ link: requested, ...NO_MOTION }, 500);
    }
  }

  try {
    return await withStorageScope(async () => {
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
