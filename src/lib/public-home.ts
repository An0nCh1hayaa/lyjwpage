import { getActivitySnapshot } from "@/lib/activity";
import { getServerSnapshot } from "@/lib/server";
import { getChargerSnapshot, withChargerFreshness } from "@/lib/anker";
import { getPowerBankSnapshot, withPowerBankFreshness } from "@/lib/powerbank";
import { statusEnvelope } from "@/lib/api";
import { getRecentlyPlayed } from "@/lib/apple-music-store";
import { getNowWatching, getWatching } from "@/lib/emby";
import { getGithubChart } from "@/lib/github-chart";
import { pickNowListening } from "@/lib/now-listening";
import { resolveLyrics, type LyricsResult } from "@/lib/lyrics";
import { getPlaying, getPlayingNow } from "@/lib/playstation";
import { getTrophiesSummary } from "@/lib/trophies";
import { readLiveness } from "@/lib/reporter-liveness";
import { getDesktopPayload, getNowListeningSnapshot, getTimezonePayload } from "@/lib/telemetry";
import { getVibeCodingSnapshot } from "@/lib/vibecoding";
import { getVibeCodingYear } from "@/lib/vibecoding-year-store";


const CHARGER_FALLBACK_WINDOW_MS = 20 * 60_000;

/**
 * 首屏曲线只画最近 20 分钟；保留窗口左边界之前的一个点，SVG 才能把跨界线段
 * 连续地裁到边缘。完整 400 点仍留在 SQLite 和状态端点，挂载后继续从最新游标
 * 增量同步，这里只缩小 RSC/HTML 里的首屏投影。
 */
async function getChargerFallback() {
  const payload = withChargerFreshness(await getChargerSnapshot());
  const { history } = payload;
  if (history.length < 2) return payload;

  const end = history[history.length - 1].t;
  const firstInside = history.findIndex(
    (sample) => sample.t >= end - CHARGER_FALLBACK_WINDOW_MS,
  );
  if (firstInside <= 0) return payload;

  return { ...payload, history: history.slice(firstInside - 1) };
}


export async function publicHomeSnapshot() {
  const [desktop, activity, server, charger, powerBank, listening, nowListening, timezone, vibeCoding, vibeCodingYear, watching, nowWatching, playing, playingNow, trophies, githubChart] = await Promise.all([
    statusEnvelope(getDesktopPayload),
    statusEnvelope(getActivitySnapshot),
    statusEnvelope(getServerSnapshot),
    statusEnvelope(getChargerFallback),
    statusEnvelope(async () => withPowerBankFreshness(await getPowerBankSnapshot())),
    statusEnvelope(getRecentlyPlayed),
    statusEnvelope(async () => pickNowListening(await getNowListeningSnapshot(), await readLiveness())),
    statusEnvelope(getTimezonePayload),
    statusEnvelope(getVibeCodingSnapshot),
    statusEnvelope(getVibeCodingYear),
    statusEnvelope(getWatching),
    statusEnvelope(getNowWatching),
    statusEnvelope(getPlaying),
    statusEnvelope(getPlayingNow),
    statusEnvelope(getTrophiesSummary),
    statusEnvelope(getGithubChart),
  ]);
  let lyrics: LyricsResult | null = null;
  if (nowListening.ok && !nowListening.data.idle && nowListening.data.hasLyrics && nowListening.data.songId) {
    try { lyrics = await resolveLyrics(nowListening.data.songId); } catch (error) { console.error("[home lyrics]", error); }
  }
  return { desktop, activity, server, charger, powerBank, listening, nowListening, timezone, vibeCoding, vibeCodingYear, watching, nowWatching, playing, playingNow, trophies, githubChart, lyrics };
}
export type HomeSnapshot = Awaited<ReturnType<typeof publicHomeSnapshot>>;
