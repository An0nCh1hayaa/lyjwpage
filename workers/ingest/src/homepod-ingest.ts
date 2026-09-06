import { NOW_LISTENING_TAG } from "@/lib/live-events";
import { fanout } from "@ingest/fanout";
import { normalizeHomePodEvent, writeHomePodEvent } from "@ingest/stores/homepod-store";
import { homePodListeningEvent } from "@ingest/stores/telemetry";

/**
 * Home Assistant 推来的 HomePod 曲目和播放状态变化。
 *
 * HomePod 只影响播放，不碰前台应用。落库和推送同时发车 —— 推的那份就是手上这一份，
 * 不必等它写进 Redis，先后为什么可以这样见 lib/live-events 的 fanout。
 *
 * 和别的来源一样是一个 `record*`，app/api/ingest/homepod 和 workers/ingest 各调一次；
 * 从前这段逻辑写在路由文件里，Worker 一来就得抄第二份。
 */
export async function recordHomePodEvent(body: unknown) {
  const stored = normalizeHomePodEvent(body);
  await fanout({
    writes: [writeHomePodEvent(stored)],
    events: [homePodListeningEvent(stored)],
    urgentTags: [NOW_LISTENING_TAG],
  });
  return { source: stored.music.source, state: stored.music.state };
}
