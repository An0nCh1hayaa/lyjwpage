import { cacheLife, cacheTag } from "next/cache";

import { getActivitySnapshot } from "@/lib/activity";
import { getServerSnapshot } from "@/lib/server";
import { getChargerSnapshot, withChargerFreshness } from "@/lib/anker";
import { getPowerBankSnapshot, withPowerBankFreshness } from "@/lib/powerbank";
import { statusEnvelope, statusSource } from "@/lib/api";
import { getRecentlyPlayed } from "@/lib/apple-music-store";
import { getNowWatching, getWatching } from "@/lib/emby";
import { getGithubChart } from "@/lib/github-chart";
import {
  ACTIVITY_TAG,
  SERVER_TAG,
  CHARGER_TAG,
  POWERBANK_TAG,
  DESKTOP_TAG,
  LISTENING_TAG,
  NOW_LISTENING_TAG,
  NOW_PLAYING_TAG,
  NOW_WATCHING_TAG,
  PLAYING_TAG,
  TIMEZONE_TAG,
  TROPHIES_TAG,
  VIBECODING_TAG,
  VIBECODING_YEAR_TAG,
  WATCHING_TAG,
} from "@/lib/live-events";
import { pickNowListening } from "@/lib/now-listening";
import { resolveLyrics, type LyricsResult } from "@/lib/lyrics";
import { getPlaying, getPlayingNow } from "@/lib/playstation";
import { getTrophies, getTrophiesSummary } from "@/lib/trophies";
import { readLiveness } from "@/lib/reporter-liveness";
import { getDesktopPayload, getNowListeningSnapshot, getTimezonePayload } from "@/lib/telemetry";
import { getVibeCodingSnapshot } from "@/lib/vibecoding";
import { getVibeCodingYear } from "@/lib/vibecoding-year-store";
import { statusCacheTag, type StatusCacheScope } from "@/lib/status-cache-scope";

/**
 * 首屏与状态 API 的缓存层。相同 loader 按 scope 生成独立条目和标签：
 * page 只允许后台更新，api 保留 urgent 立即失效，见 lib/live-events。
 * 共享函数的 scope 必填，并作为可序列化参数进入 use cache 的键；嵌套缓存也必须
 * 沿用同一个 scope，否则内层的 API 标签会传播到首屏，使整页再次阻塞重建。
 *
 * STATUS_CACHE=false 只让 API 改为直读 Redis，首屏仍需缓存才能预渲染。
 * Mac 存活、充电头 pushedAt、播放断流等随时间变化的字段在 API 出口现盖一层。
 * Vercel 共享 tag 存储，其他多实例部署仍受本实例失效的限制，见 expireStatus。
 */

/**
 * stale 5 分钟 / revalidate 10 分钟 / expire 7 天。
 *
 * 主力失效手段是 tag。10 分钟兜底留给首屏 HTML：上报器悄无声息死掉不会触发
 * tag，存活窗口默认 5 分钟（HEARTBEAT_WINDOW_MS），首屏那份 lastSeenAt 最多冻
 * 这 10 分钟。API 路径会现读存活。
 *
 * revalidate 和 expire 是两种「过期」，代价差一个数量级：过了 revalidate 的
 * 请求**立刻拿到旧的那份**、新的在后台重建；过了 expire 就没有旧的可给了，
 * 那一位访客得站着等整页重算完。所以 expire 从 2 小时放到 7 天 —— 宁愿夜里
 * 头一位访客看到的是几小时前的数字（挂载后 SWR 立刻纠正），也不要让他等。
 * 兜底新鲜度由 revalidate 那 10 分钟负责，不受这里影响。
 *
 * 不能再短：revalidate 为 0 或 expire 短于 5 分钟的缓存会被排除在预渲染之外、
 * 退化成请求时的动态洞，那就等于没缓存。
 */
const STATUS_LIFE = {
  stale: 5 * 60,
  revalidate: 10 * 60,
  expire: 7 * 24 * 60 * 60,
};
const CHARGER_FALLBACK_WINDOW_MS = 20 * 60_000;

/**
 * 首屏曲线只画最近 20 分钟；保留窗口左边界之前的一个点，SVG 才能把跨界线段
 * 连续地裁到边缘。完整 400 点仍留在 Redis 和状态端点，挂载后继续从最新游标
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

export async function cachedDesktop(scope: StatusCacheScope) {
  "use cache";
  cacheLife(STATUS_LIFE);
  cacheTag(statusCacheTag(scope, DESKTOP_TAG));
  return statusEnvelope(getDesktopPayload);
}

export async function cachedTimezone() {
  "use cache";
  cacheLife(STATUS_LIFE);
  cacheTag(statusCacheTag("page", TIMEZONE_TAG));
  return statusEnvelope(getTimezonePayload);
}

/** 曲线不带游标：服务端手上没有客户端已有的序列，只能发全量 */
export async function cachedCharger() {
  "use cache";
  cacheLife(STATUS_LIFE);
  cacheTag(statusCacheTag("page", CHARGER_TAG));
  return statusEnvelope(getChargerFallback);
}

/**
 * 充电宝首屏。
 *
 * 不需要像充电头那样裁历史窗口 —— 这张卡没有曲线，快照本身就是全部内容。
 */
export async function cachedPowerBank() {
  "use cache";
  cacheLife(STATUS_LIFE);
  cacheTag(statusCacheTag("page", POWERBANK_TAG));
  return statusEnvelope(async () => withPowerBankFreshness(await getPowerBankSnapshot()));
}

/** 状态端点用的完整 400 点。插拔时立即失效，首屏那份仅后台更新。 */
export async function cachedChargerSnapshot() {
  "use cache";
  cacheLife(STATUS_LIFE);
  cacheTag(statusCacheTag("api", CHARGER_TAG));
  return statusEnvelope(getChargerSnapshot);
}

export async function cachedPowerBankSnapshot() {
  "use cache";
  cacheLife(STATUS_LIFE);
  cacheTag(statusCacheTag("api", POWERBANK_TAG));
  return statusEnvelope(getPowerBankSnapshot);
}

/**
 * 活动圆环。首屏与端点共用 loader，按 scope 分开缓存。
 *
 * 「跨没跨过午夜」在这里会被冻住（最长 10 分钟），端点那侧每次请求重新盖一遍，
 * 见 app/api/status/activity 和 lib/activity 的 withActivityFreshness。
 */
export async function cachedActivity(scope: StatusCacheScope) {
  "use cache";
  cacheLife(STATUS_LIFE);
  cacheTag(statusCacheTag(scope, ACTIVITY_TAG));
  return statusEnvelope(getActivitySnapshot);
}

/**
 * 服务器快照。首屏与端点共用 loader，按 scope 分开缓存。
 *
 * 「上报器还活着没有」在这里会被冻住（最长 10 分钟），端点那侧每次请求重新
 * 盖一遍，见 app/api/status/server 和 lib/server 的 withServerFreshness。
 */
export async function cachedServer(scope: StatusCacheScope) {
  "use cache";
  cacheLife(STATUS_LIFE);
  cacheTag(statusCacheTag(scope, SERVER_TAG));
  return statusEnvelope(getServerSnapshot);
}

export async function cachedVibeCoding(scope: StatusCacheScope) {
  "use cache";
  cacheLife(STATUS_LIFE);
  cacheTag(statusCacheTag(scope, VIBECODING_TAG));
  return statusEnvelope(getVibeCodingSnapshot);
}

export async function cachedVibeCodingYear(scope: StatusCacheScope) {
  "use cache";
  cacheLife(STATUS_LIFE);
  cacheTag(statusCacheTag(scope, VIBECODING_YEAR_TAG));
  return statusEnvelope(getVibeCodingYear);
}

export async function cachedListening(scope: StatusCacheScope) {
  "use cache";
  cacheLife(STATUS_LIFE);
  cacheTag(statusCacheTag(scope, LISTENING_TAG));
  return statusEnvelope(getRecentlyPlayed);
}

/** 两个候选。首屏和 `/api/status/listening/now` 各自缓存，再各自选 Hero。 */
export async function cachedNowListeningSnapshot(scope: StatusCacheScope) {
  "use cache";
  cacheLife(STATUS_LIFE);
  cacheTag(statusCacheTag(scope, NOW_LISTENING_TAG));
  return statusEnvelope(getNowListeningSnapshot);
}

export async function cachedNowListening() {
  "use cache";
  cacheLife(STATUS_LIFE);
  cacheTag(statusCacheTag("page", NOW_LISTENING_TAG));
  // 首屏冻住选好的 Hero，避免 LCP 闪。挂载后 SWR 打 listening/now 现选。
  const envelope = await cachedNowListeningSnapshot("page");
  if (!envelope.ok) return envelope;
  return statusEnvelope(async () =>
    pickNowListening(envelope.data, await readLiveness()),
  );
}

/** 条数用 getWatching 自己的默认值，理由同 /api/status/watching：别在两处各写一遍 */
export async function cachedWatching(scope: StatusCacheScope) {
  "use cache";
  cacheLife(STATUS_LIFE);
  cacheTag(statusCacheTag(scope, WATCHING_TAG));
  return statusEnvelope(getWatching);
}

/** 只有首屏用。端点那份两条路都直读，见下面 nowWatchingStatus */
export async function cachedNowWatching() {
  "use cache";
  cacheLife(STATUS_LIFE);
  cacheTag(statusCacheTag("page", NOW_WATCHING_TAG));
  return statusEnvelope(getNowWatching);
}

export async function cachedPlaying(scope: StatusCacheScope) {
  "use cache";
  cacheLife(STATUS_LIFE);
  cacheTag(statusCacheTag(scope, PLAYING_TAG));
  return statusEnvelope(getPlaying);
}

export async function cachedPlayingNow(scope: StatusCacheScope) {
  "use cache";
  cacheLife(STATUS_LIFE);
  cacheTag(statusCacheTag(scope, NOW_PLAYING_TAG));
  return statusEnvelope(getPlayingNow);
}

export async function cachedTrophies() {
  "use cache";
  cacheLife(STATUS_LIFE);
  cacheTag(statusCacheTag("api", TROPHIES_TAG));
  return statusEnvelope(getTrophies);
}

/** 首屏要等级、合计和各标题进度，整份奖杯明细点瓷砖再拉。 */
export async function cachedTrophiesSummary() {
  "use cache";
  cacheLife(STATUS_LIFE);
  cacheTag(statusCacheTag("page", TROPHIES_TAG));
  return statusEnvelope(getTrophiesSummary);
}

export async function cachedGithubChart() {
  "use cache";
  cacheLife(STATUS_LIFE);
  return statusEnvelope(getGithubChart);
}

/**
 * 首屏同步歌词：按曲目 ID 缓存解析后的歌词。
 *
 * 不用 `cacheLife("max")`：resolveLyrics 自己的 Redis 层按结论分档（有 7 天、
 * 没有 1 小时，理由见 lib/lyrics 的 NO_LYRICS_TTL_MS），max 会把「没有」和这里
 * 吞掉错误后的 null 一起冻到下次部署，那首歌的首屏从此没词。revalidate 取 1 小时
 * 对齐那档负缓存，expire 取 7 天对齐正缓存；这层只是首屏预渲染的壳，真正的
 * 长期缓存在 Redis。
 */
const LYRICS_LIFE = { revalidate: 60 * 60, expire: 7 * 24 * 60 * 60 };

export async function cachedLyrics(songId: string): Promise<LyricsResult | null> {
  "use cache";
  cacheLife(LYRICS_LIFE);
  try {
    return await resolveLyrics(songId);
  } catch (error) {
    console.error("[cachedLyrics]", error);
    return null;
  }
}

/**
 * `app/api/status/` 下每条端点各自的两种取法，一条一对，见 lib/api 的
 * `StatusSource`：API 缓存走上面的 `'use cache'`，直读那份走同一个 loader，
 * 由 STATUS_CACHE 选。
 *
 * 配对摆在这里而不是各条路由里：这个文件本来就同时拿着 tag 和 loader，而路由那边
 * 每加一处「哪份缓存对应哪个 loader」的知识，就多一处能对不上的地方。
 *
 * 充电头和充电宝给端点的是**完整快照**，首屏那两份（cachedCharger /
 * cachedPowerBank）分别裁历史窗口或盖新鲜度，两者不是同一份。
 */
export const desktopStatus = statusSource(() => cachedDesktop("api"), getDesktopPayload);
export const chargerStatus = statusSource(cachedChargerSnapshot, getChargerSnapshot);
export const powerBankStatus = statusSource(cachedPowerBankSnapshot, getPowerBankSnapshot);
export const activityStatus = statusSource(() => cachedActivity("api"), getActivitySnapshot);
export const serverStatus = statusSource(() => cachedServer("api"), getServerSnapshot);
export const vibeCodingStatus = statusSource(() => cachedVibeCoding("api"), getVibeCodingSnapshot);
export const vibeCodingYearStatus = statusSource(() => cachedVibeCodingYear("api"), getVibeCodingYear);
export const listeningStatus = statusSource(() => cachedListening("api"), getRecentlyPlayed);
export const nowListeningStatus = statusSource(
  () => cachedNowListeningSnapshot("api"),
  getNowListeningSnapshot,
);
export const watchingStatus = statusSource(() => cachedWatching("api"), getWatching);
/**
 * Emby 此刻在播的端点**两条路都直读**。
 *
 * 进度是读的那一刻按墙上的钟推算的（emby-store 的 resolveNowPlaying），快照里
 * 没有能重新投影的原始时刻，所以路由从前在 overlay 里整个重读一遍 —— 缓存那份
 * 读完就扔，api 条目和它的 tag 失效全是白做的。首屏那份仍走 cachedNowWatching，
 * 冻住的进度由挂载后的第一次轮询纠正。
 */
export const nowWatchingStatus = statusSource(
  () => statusEnvelope(getNowWatching),
  getNowWatching,
);
export const playingStatus = statusSource(() => cachedPlaying("api"), getPlaying);
export const playingNowStatus = statusSource(() => cachedPlayingNow("api"), getPlayingNow);
export const trophiesStatus = statusSource(cachedTrophies, getTrophies);
export const githubChartStatus = statusSource(cachedGithubChart, getGithubChart);
