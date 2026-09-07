import { isStale, playstationStaleMs } from "@/lib/freshness";
import { statusRoute } from "@/lib/api";
import { assertPresenceFresh, getPlayingNow } from "@/lib/playstation";
import { playingNowStatus } from "@/lib/status-sources";

export function GET() {
  return statusRoute(playingNowStatus, async (data) => {
    if (!isStale({ now: Date.now(), at: data.observedAt, windowMs: playstationStaleMs() })) {
      return data;
    }
    return assertPresenceFresh(await getPlayingNow());
  });
}
