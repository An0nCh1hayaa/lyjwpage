
import { resolveLyrics, type LyricsResult } from "@/lib/lyrics";
import { readNowListening } from "@/lib/now-listening-read";
import { withStorageScope } from "@/lib/storage";


export type LyricsNowResponse = LyricsResult & { songId: string | null };

export async function GET(request: Request) {


  const requested = new URL(request.url).searchParams.get("song")?.trim() ?? "";
  if (requested) {
    if (!/^\d{1,20}$/.test(requested)) {
      return jsonResponse(
        { songId: null, lines: [], error: 'Invalid "song" query parameter' },
        400,
      );
    }
    try {
      const result = await withStorageScope(() => resolveLyrics(requested));
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
    return await withStorageScope(async () => {
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
      "Cache-Control":
        cacheTtl > 0
          ? `public, max-age=${cacheTtl}, s-maxage=${cacheTtl}`
          : "no-store, no-cache, must-revalidate",
    },
  });
}
