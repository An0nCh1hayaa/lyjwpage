import { AwaitingReport } from "@/lib/awaiting-report";
import { isStale, playstationStaleMs } from "@/lib/freshness";
import { number, object, text } from "@/lib/json";
import {
  fanout,
  NOW_PLAYING_TAG,
  PLAYING_TAG,
  TROPHIES_TAG,
  type PendingEvent,
} from "@/lib/live-events";
import {
  getPlaystationPlayedGames,
  getPlaystationPresence,
  getPlaystationTrophies,
  setPlaystationPlayedGames,
  setPlaystationPresence,
  setPlaystationTrophies,
} from "@/lib/playstation-store";
import { normalizeTrophies, trophiesContent } from "@/lib/trophies";
import type {
  PlaystationGame,
  PlaystationNowPlaying,
  PlaystationPlayingPayload,
  PlaystationPresencePayload,
} from "@/lib/types";

function requiredNumber(
  row: Record<string, unknown>,
  field: string,
  context: string,
): number {
  const value = number(row[field]);
  if (value == null || value < 0) {
    throw new Error(`${context} 的 ${field} 必须是非负数字`);
  }
  return value;
}

function requiredText(
  row: Record<string, unknown>,
  field: string,
  context: string,
): string {
  const value = text(row[field]);
  if (!value) throw new Error(`${context} 的 ${field} 必须是非空字符串`);
  return value;
}

function nullableNumber(
  row: Record<string, unknown>,
  field: string,
  context: string,
): number | null {
  if (!(field in row)) throw new Error(`${context} 缺少 ${field}`);
  if (row[field] == null) return null;
  return requiredNumber(row, field, context);
}

function nullableText(
  row: Record<string, unknown>,
  field: string,
  context: string,
): string | null {
  if (!(field in row)) throw new Error(`${context} 缺少 ${field}`);
  if (row[field] == null) return null;
  return requiredText(row, field, context);
}

function requiredBoolean(
  row: Record<string, unknown>,
  field: string,
  context: string,
): boolean {
  const value = row[field];
  if (typeof value !== "boolean") {
    throw new Error(`${context} 的 ${field} 必须是布尔值`);
  }
  return value;
}

function normalizeNowPlaying(value: unknown): PlaystationNowPlaying | null {
  if (value == null) return null;
  const row = object(value);
  if (!row) throw new Error("PlayStation presence.playing 必须是对象或 null");
  return {
    titleId: requiredText(row, "titleId", "PlayStation presence.playing"),
    title: requiredText(row, "title", "PlayStation presence.playing"),
    format: nullableText(row, "format", "PlayStation presence.playing"),
    launchPlatform: nullableText(row, "launchPlatform", "PlayStation presence.playing"),
    iconUrl: nullableText(row, "iconUrl", "PlayStation presence.playing"),
  };
}

export function normalizePlaystationPresence(value: unknown): PlaystationPresencePayload {
  const row = object(value);
  if (!row) throw new Error("PlayStation presence 必须是对象");
  if (typeof row.online !== "boolean") {
    throw new Error("PlayStation presence 的 online 必须是布尔值");
  }
  if (!("playing" in row)) throw new Error("PlayStation presence 缺少 playing");

  return {
    observedAt: requiredNumber(row, "observedAt", "PlayStation presence"),
    online: row.online,
    availability: nullableText(row, "availability", "PlayStation presence"),
    platform: nullableText(row, "platform", "PlayStation presence"),
    lastOnlineAt: nullableNumber(row, "lastOnlineAt", "PlayStation presence"),
    playing: normalizeNowPlaying(row.playing),
  };
}

function normalizeGame(value: unknown, index: number): PlaystationGame {
  const row = object(value);
  const context = `PlayStation playedGames.items[${index}]`;
  if (!row) throw new Error(`${context} 必须是对象`);

  return {
    titleId: requiredText(row, "titleId", context),
    name: requiredText(row, "name", context),
    category: nullableText(row, "category", context),
    playCount: requiredNumber(row, "playCount", context),
    firstPlayedAt: nullableNumber(row, "firstPlayedAt", context),
    lastPlayedAt: nullableNumber(row, "lastPlayedAt", context),
    playDurationMs: nullableNumber(row, "playDurationMs", context),
    imageUrl: nullableText(row, "imageUrl", context),
    service: nullableText(row, "service", context),
    preOrder: requiredBoolean(row, "preOrder", context),
  };
}

export function normalizePlaystationPlayedGames(value: unknown): PlaystationPlayingPayload {
  const row = object(value);
  if (!row) throw new Error("PlayStation playedGames 必须是对象");
  if (!Array.isArray(row.items)) {
    throw new Error("PlayStation playedGames.items 必须是数组");
  }
  return {
    observedAt: requiredNumber(row, "observedAt", "PlayStation playedGames"),
    items: row.items.map(normalizeGame),
  };
}

/** observedAt 是采集时刻，不参与“内容有没有变化”的判断。 */
function presenceContent(payload: PlaystationPresencePayload) {
  return {
    online: payload.online,
    availability: payload.availability,
    platform: payload.platform,
    lastOnlineAt: payload.lastOnlineAt,
    playing: payload.playing,
  };
}

export async function getPlaying(): Promise<PlaystationPlayingPayload> {
  const payload = await getPlaystationPlayedGames();
  if (!payload) throw new AwaitingReport("尚未收到 PlayStation 最近游玩遥测");
  return payload;
}

export async function getPlayingNow(): Promise<PlaystationPresencePayload> {
  const payload = await getPlaystationPresence();
  if (!payload) throw new AwaitingReport("尚未收到 PlayStation 在线状态遥测");
  return payload;
}

/**
 * presence 是心跳：Worker 每轮 cron 都发一封，内容没变也发。于是「observedAt
 * 多久没动」就是「Worker 还活着没有」，而这个判定光靠时间流逝就会翻面 ——
 * 所以它在**读的出口每次请求现算**，不进 'use cache'。冻进快照的话 Worker
 * 死掉之后页面会一直举着「正在游玩」，快照 TTL 还有 30 天。
 *
 * 断流不等于离线：Worker 死了我们只是**不知道**他在不在玩。所以退成
 * AwaitingReport 交给 statusRoute 发降级信封，卡片照旧摆最近在玩的瓷砖、
 * 只是不再有「正在游玩」那一行 —— 而不是伪造一个 online:false 说他下线了。
 */
export function assertPresenceFresh(
  payload: PlaystationPresencePayload,
  now = Date.now(),
): PlaystationPresencePayload {
  if (!isStale({ now, at: payload.observedAt, windowMs: playstationStaleMs() })) {
    return payload;
  }
  const minutes = Math.round(Math.max(0, now - payload.observedAt) / 60_000);
  throw new AwaitingReport(`PlayStation 在线状态遥测断流：最后一次采集在 ${minutes} 分钟前`);
}

/*
 * 首屏那份**不**过这道判定：它在预渲染里跑，而 Date.now() 进预渲染就是
 * E1432（首屏必须冻得住）。和充电头、活动圆环同一个取舍 —— 第一帧可能举着
 * 断流前的旧状态，挂载后第一次回源走上面的路由 overlay 就纠正了。
 */

/**
 * 三部分各自可省；缺席表示这次不谈这一项。站点再比一次内容，避免重试或手工
 * 兜底上报退化成广播。写、带数据推送与 tag 失效统一交给 fanout 排序。
 *
 * 奖杯目录只失效、不推：整份几百 KB，解锁又不是按秒翻的事。
 */
export async function recordPlaystationReport(input: unknown) {
  const envelope = object(input);
  if (!envelope || envelope.version !== 1) {
    throw new Error("PlayStation 遥测协议 version 必须为 1");
  }

  const incomingPresence =
    "presence" in envelope ? normalizePlaystationPresence(envelope.presence) : null;
  const incomingPlayedGames =
    "playedGames" in envelope
      ? normalizePlaystationPlayedGames(envelope.playedGames)
      : null;
  const incomingTrophies =
    "trophies" in envelope ? normalizeTrophies(envelope.trophies) : null;

  const [previousPresence, previousPlayedGames, previousTrophies] = await Promise.all([
    incomingPresence ? getPlaystationPresence() : null,
    incomingPlayedGames ? getPlaystationPlayedGames() : null,
    incomingTrophies ? getPlaystationTrophies() : null,
  ]);

  const presenceChanged =
    incomingPresence != null &&
    (!previousPresence ||
      JSON.stringify(presenceContent(previousPresence)) !==
        JSON.stringify(presenceContent(incomingPresence)));
  const playedGamesChanged =
    incomingPlayedGames != null &&
    JSON.stringify(previousPlayedGames?.items ?? null) !==
      JSON.stringify(incomingPlayedGames.items);
  const trophiesChanged =
    incomingTrophies != null &&
    JSON.stringify(previousTrophies ? trophiesContent(previousTrophies) : null) !==
      JSON.stringify(trophiesContent(incomingTrophies));

  const writes: Promise<unknown>[] = [];
  const events: PendingEvent[] = [];
  const tags: string[] = [];

  const urgentTags: string[] = [];
  if (incomingPresence) {
    /**
     * 内容没变也要落库：presence 是心跳（Worker 每轮 cron 都发一封），
     * observedAt 就是心跳本身，不刷新它的话读那侧永远判不出 Worker 是什么时候
     * 死的，断流判定（assertPresenceFresh）等于白写。
     *
     * 但没变就不广播 —— 推一条一模一样的事件是拿推送当轮询用。tag 仍然要推，
     * 走普通那半：不推的话 'use cache' 里那份快照的 observedAt 跟着冻住，心跳
     * 刷新的只有 Redis，端点读到的还是老时刻。普通 tag 给的是
     * stale-while-revalidate，落后一个刷新周期，窗口已经把这一截算进去了。
     */
    writes.push(setPlaystationPresence(incomingPresence));
    if (presenceChanged || !previousPresence) {
      events.push({ type: "playing-now", payload: incomingPresence });
      // 「正在游玩」和听歌 now 一样：不能先把旧值再顶几分钟。
      urgentTags.push(NOW_PLAYING_TAG);
    } else {
      tags.push(NOW_PLAYING_TAG);
    }
  }
  if (incomingPlayedGames && (playedGamesChanged || !previousPlayedGames)) {
    writes.push(setPlaystationPlayedGames(incomingPlayedGames));
    events.push({ type: "playing", payload: incomingPlayedGames });
    urgentTags.push(PLAYING_TAG);
    // 奖杯目录的时长和 Plus / 预购是读时按 titleIds 盖上去的，游玩一变就得重算。
    tags.push(TROPHIES_TAG);
  }
  if (incomingTrophies && (trophiesChanged || !previousTrophies)) {
    writes.push(setPlaystationTrophies(incomingTrophies));
    // 目录是整份替换：旧标题必须立刻从 status 里消失，不能再 SWR 几分钟。
    urgentTags.push(TROPHIES_TAG);
  }

  await fanout({ writes, events, tags, urgentTags });
  return { changed: presenceChanged || playedGamesChanged || trophiesChanged };
}
