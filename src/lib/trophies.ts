import { AwaitingReport } from "@/lib/awaiting-report";
import { number, object, text } from "@/lib/json";
import {
  getPlaystationPlayedGames,
  getPlaystationTrophies,
} from "@/lib/playstation-store";
import { foldService } from "@/lib/playstation-entitlements";
import type { PlaystationGame } from "@/lib/types";
import { addTrophyCounts, emptyTrophyCounts } from "@/lib/trophy-counts";
import {
  TROPHY_TYPES,
  type TrophiesPayload,
  type TrophiesSummaryPayload,
  type Trophy,
  type TrophyCounts,
  type TrophyGroup,
  type TrophyProfile,
  type TrophyTitle,
  type TrophyTitleDigest,
  type TrophyType,
  type TrophyUnlock,
} from "@/lib/types";

const TROPHY_TYPE_SET = new Set<string>(TROPHY_TYPES);

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

/**
 * PSN 有几路图还在发 http:// 的地址。页面是 https，混合内容会被浏览器直接拦掉，
 * 而 next/image 的 remotePatterns 也只放行了 https 那一份 —— 所以入库前统一升级。
 * 头像、奖杯组图标、奖杯图标都要过一遍，漏一处就是那一路图全空。
 */
function httpsUrl(value: string | null): string | null {
  return value ? value.replace(/^http:\/\//i, "https://") : null;
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

function normalizeCounts(value: unknown, context: string): TrophyCounts {
  const row = object(value);
  if (!row) throw new Error(`${context} 必须是对象`);
  return {
    platinum: requiredNumber(row, "platinum", context),
    gold: requiredNumber(row, "gold", context),
    silver: requiredNumber(row, "silver", context),
    bronze: requiredNumber(row, "bronze", context),
  };
}

function normalizeProfile(value: unknown): TrophyProfile {
  const row = object(value);
  if (!row) throw new Error("PlayStation trophies.profile 必须是对象");
  const levelProgress = requiredNumber(row, "levelProgress", "PlayStation trophies.profile");
  if (levelProgress > 100) {
    throw new Error("PlayStation trophies.profile 的 levelProgress 必须在 0–100");
  }
  return {
    onlineId: requiredText(row, "onlineId", "PlayStation trophies.profile"),
    avatarUrl: httpsUrl(nullableText(row, "avatarUrl", "PlayStation trophies.profile")),
    plus: requiredBoolean(row, "plus", "PlayStation trophies.profile"),
    level: requiredNumber(row, "level", "PlayStation trophies.profile"),
    tier: requiredNumber(row, "tier", "PlayStation trophies.profile"),
    trophyPoint: requiredNumber(row, "trophyPoint", "PlayStation trophies.profile"),
    levelBasePoint: requiredNumber(row, "levelBasePoint", "PlayStation trophies.profile"),
    levelNextPoint: requiredNumber(row, "levelNextPoint", "PlayStation trophies.profile"),
    levelProgress,
    earned: normalizeCounts(row.earned, "PlayStation trophies.profile.earned"),
  };
}

function normalizeGroup(value: unknown, index: number, titleId: string): TrophyGroup {
  const context = `PlayStation trophies.titles[${titleId}].groups[${index}]`;
  const row = object(value);
  if (!row) throw new Error(`${context} 必须是对象`);
  const progress = requiredNumber(row, "progress", context);
  if (progress > 100) throw new Error(`${context} 的 progress 必须在 0–100`);
  return {
    id: requiredText(row, "id", context),
    name: requiredText(row, "name", context),
    iconUrl: httpsUrl(nullableText(row, "iconUrl", context)),
    progress,
    defined: normalizeCounts(row.defined, `${context}.defined`),
    earned: normalizeCounts(row.earned, `${context}.earned`),
  };
}

function normalizeTrophyType(value: unknown, context: string): TrophyType {
  if (typeof value !== "string" || !TROPHY_TYPE_SET.has(value)) {
    throw new Error(`${context} 的 type 必须是 platinum / gold / silver / bronze`);
  }
  return value as TrophyType;
}

function normalizeTrophy(value: unknown, index: number, titleId: string): Trophy {
  const context = `PlayStation trophies.titles[${titleId}].trophies[${index}]`;
  const row = object(value);
  if (!row) throw new Error(`${context} 必须是对象`);
  const id = number(row.id);
  if (id == null || id < 0 || !Number.isInteger(id)) {
    throw new Error(`${context} 的 id 必须是非负整数`);
  }
  const earnedRate = nullableNumber(row, "earnedRate", context);
  if (earnedRate != null && earnedRate > 100) {
    throw new Error(`${context} 的 earnedRate 必须在 0–100`);
  }
  return {
    id,
    type: normalizeTrophyType(row.type, context),
    name: requiredText(row, "name", context),
    detail: nullableText(row, "detail", context),
    iconUrl: httpsUrl(nullableText(row, "iconUrl", context)),
    hidden: requiredBoolean(row, "hidden", context),
    groupId: requiredText(row, "groupId", context),
    earned: requiredBoolean(row, "earned", context),
    earnedAt: nullableNumber(row, "earnedAt", context),
    earnedRate,
  };
}

function normalizeTitleIds(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${context}.titleIds 必须是数组`);
  return value.map((item, index) => {
    const id = text(item);
    if (!id) throw new Error(`${context}.titleIds[${index}] 必须是非空字符串`);
    return id;
  });
}

function normalizeTitle(value: unknown, index: number): TrophyTitle {
  const row = object(value);
  const context = `PlayStation trophies.titles[${index}]`;
  if (!row) throw new Error(`${context} 必须是对象`);
  const npCommunicationId = requiredText(row, "npCommunicationId", context);
  const progress = requiredNumber(row, "progress", context);
  if (progress > 100) throw new Error(`${context} 的 progress 必须在 0–100`);
  if (!Array.isArray(row.groups)) throw new Error(`${context}.groups 必须是数组`);
  if (!Array.isArray(row.trophies)) throw new Error(`${context}.trophies 必须是数组`);
  return {
    npCommunicationId,
    name: requiredText(row, "name", context),
    localizedName: nullableText(row, "localizedName", context),
    titleIds: normalizeTitleIds(row.titleIds, context),
    iconUrl: httpsUrl(nullableText(row, "iconUrl", context)),
    platform: requiredText(row, "platform", context),
    progress,
    defined: normalizeCounts(row.defined, `${context}.defined`),
    earned: normalizeCounts(row.earned, `${context}.earned`),
    lastUpdatedAt: nullableNumber(row, "lastUpdatedAt", context),
    playDurationMs: nullableNumber(row, "playDurationMs", context),
    playCount: requiredNumber(row, "playCount", context),
    firstPlayedAt: nullableNumber(row, "firstPlayedAt", context),
    lastPlayedAt: nullableNumber(row, "lastPlayedAt", context),
    service: nullableText(row, "service", context),
    preOrder: requiredBoolean(row, "preOrder", context),
    groups: row.groups.map((group, groupIndex) =>
      normalizeGroup(group, groupIndex, npCommunicationId),
    ),
    trophies: row.trophies.map((trophy, trophyIndex) =>
      normalizeTrophy(trophy, trophyIndex, npCommunicationId),
    ),
  };
}

export function normalizeTrophies(value: unknown): TrophiesPayload {
  const row = object(value);
  if (!row) throw new Error("PlayStation trophies 必须是对象");
  if (!Array.isArray(row.titles)) {
    throw new Error("PlayStation trophies.titles 必须是数组");
  }
  return {
    observedAt: requiredNumber(row, "observedAt", "PlayStation trophies"),
    profile: normalizeProfile(row.profile),
    titles: row.titles.map(normalizeTitle),
  };
}

/** observedAt 和游玩时长覆盖都不参与「奖杯内容有没有变」。 */
export function trophiesContent(payload: TrophiesPayload) {
  return {
    profile: payload.profile,
    titles: payload.titles.map((title) => ({
      npCommunicationId: title.npCommunicationId,
      name: title.name,
      localizedName: title.localizedName,
      titleIds: title.titleIds,
      iconUrl: title.iconUrl,
      platform: title.platform,
      progress: title.progress,
      defined: title.defined,
      earned: title.earned,
      lastUpdatedAt: title.lastUpdatedAt,
      groups: title.groups,
      trophies: title.trophies,
    })),
  };
}

function fold(
  a: number | null,
  b: number | null,
  by: (x: number, y: number) => number,
): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return by(a, b);
}

function playName(games: PlaystationGame[], trophyName: string): string | null {
  for (const game of games) {
    const name = game.name.trim();
    if (name && name !== trophyName) return name;
  }
  return null;
}

/**
 * entitlement 也得和库里那份折一次，理由和时长那几项一样：最近列表只覆盖窗口
 * 里的 SKU。`service: null` 是「上游没说」不是「不是 Plus」（见 PlaystationGame
 * 的注释），无条件盖过去会把已知的权益抹掉 —— 缺 SKU 的那一档抹得最狠，整池
 * 都对不上时连一条真话都没有。
 *
 * 池子排在前面：foldService 是 Plus 优先、其余取第一条非空，所以 `ps_plus` 谁
 * 前谁后都一样，剩下的让更新的那份说话，库里那份只填空。
 */
function entitlementsFrom(
  title: TrophyTitle,
  games: PlaystationGame[],
): Pick<TrophyTitle, "service" | "preOrder"> {
  return {
    service: foldService(...games.map((game) => game.service), title.service),
    preOrder: title.preOrder === true || games.some((game) => game.preOrder),
  };
}

/**
 * 奖杯标题的键是 NPWR…，游玩列表是 PPSA…。Worker 已经用官方
 * titleId 对齐过，这里只按 `titleIds` 把多条 SKU 的时长加总。
 * 最近列表只覆盖窗口里的游戏：缺一条 SKU 就沿用库里的数，避免把完整合计裁短。
 */
function overlayPlayStats(
  titles: TrophyTitle[],
  games: PlaystationGame[],
): TrophyTitle[] {
  if (!games.length) return titles;
  return titles.map((title) => {
    const ids = title.titleIds ?? [];
    if (!ids.length) {
      return { ...title, service: title.service ?? null, preOrder: title.preOrder === true };
    }
    const pool = ids
      .map((id) => games.find((game) => game.titleId === id))
      .filter((game): game is PlaystationGame => game != null);
    if (!pool.length) {
      return { ...title, service: title.service ?? null, preOrder: title.preOrder === true };
    }
    const localizedName = playName(pool, title.name) ?? title.localizedName;
    const entitlements = entitlementsFrom(title, pool);
    if (pool.length < ids.length) {
      return { ...title, localizedName, ...entitlements };
    }
    return {
      ...title,
      localizedName,
      playDurationMs: pool.reduce<number | null>(
        (sum, game) => fold(sum, game.playDurationMs, (x, y) => x + y),
        null,
      ),
      playCount: pool.reduce((sum, game) => sum + game.playCount, 0),
      firstPlayedAt: pool.reduce<number | null>(
        (min, game) => fold(min, game.firstPlayedAt, Math.min),
        null,
      ),
      lastPlayedAt: pool.reduce<number | null>(
        (max, game) => fold(max, game.lastPlayedAt, Math.max),
        null,
      ),
      ...entitlements,
    };
  });
}

export async function getTrophies(): Promise<TrophiesPayload> {
  const payload = await getPlaystationTrophies();
  if (!payload) throw new AwaitingReport("尚未收到 PlayStation 奖杯遥测");
  const played = await getPlaystationPlayedGames();
  if (!played?.items.length) {
    return {
      ...payload,
      titles: payload.titles.map((title) => ({
        ...title,
        service: title.service ?? null,
        preOrder: title.preOrder === true,
      })),
    };
  }
  return { ...payload, titles: overlayPlayStats(payload.titles, played.items) };
}

/**
 * 只留这几个 titleId 对得上的标题。
 *
 * 展开的那块瓷砖只用得上 1–2 款，而整份目录里每个奖杯都带说明文本和图标地址，
 * 未来是几百 KB 级的。所以过滤在读的出口做（路由 overlay），`'use cache'` 里冻
 * 的仍是整份、不按 titleIds 分缓存键 —— 分了就是每块瓷砖各占一份完整目录。
 *
 * 求交集不是相等：一款游戏可能有多个 SKU（PS4 / PS5、试玩），瓷砖是按同名同封面
 * 并过的，一块瓷砖手上就有好几个 titleId。
 */
export function sliceTrophies(
  payload: TrophiesPayload,
  titleIds: string[],
): TrophiesPayload {
  return {
    ...payload,
    titles: payload.titles.filter((title) =>
      title.titleIds.some((id) => titleIds.includes(id)),
    ),
  };
}

/**
 * 分子分母同源：两边都从 `titles` 逐金属加总。
 *
 * `profile.earned` 是**账号级**的合计，而 titles 被 Worker 的屏蔽名单
 * （PLAYSTATION_HIDDEN_TITLE_IDS）滤过 —— 拿账号级的分子配滤过的分母，屏蔽名单
 * 一非空百分比就偏高，屏蔽掉的是已通关的游戏时还能越过 100%。等级、点数那些
 * 仍然照旧读 profile：那是账号级的事实，本来就不该跟着屏蔽名单变。
 */
export function summarizeTrophies(payload: TrophiesPayload): TrophiesSummaryPayload {
  const earned = payload.titles.reduce(
    (sum, title) => addTrophyCounts(sum, title.earned),
    emptyTrophyCounts(),
  );
  const recent: TrophyUnlock[] = [];
  for (const title of payload.titles) {
    const titleName = title.localizedName ?? title.name;
    for (const trophy of title.trophies) {
      if (!trophy.earned || trophy.earnedAt == null) continue;
      recent.push({
        npCommunicationId: title.npCommunicationId,
        id: trophy.id,
        groupId: trophy.groupId,
        titleName,
        trophyName: trophy.name,
        type: trophy.type,
        iconUrl: trophy.iconUrl,
        earnedAt: trophy.earnedAt,
      });
    }
  }
  recent.sort((a, b) => b.earnedAt - a.earnedAt);
  const titles: TrophyTitleDigest[] = payload.titles.map((title) => ({
    npCommunicationId: title.npCommunicationId,
    name: title.name,
    localizedName: title.localizedName,
    titleIds: title.titleIds,
    progress: title.progress,
    defined: title.defined,
    earned: title.earned,
  }));
  return {
    observedAt: payload.observedAt,
    profile: payload.profile,
    earned,
    recent: recent.slice(0, 3),
    titles,
  };
}

export async function getTrophiesSummary(): Promise<TrophiesSummaryPayload> {
  return summarizeTrophies(await getTrophies());
}
