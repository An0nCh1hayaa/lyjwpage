import { number, object, text } from "@/lib/json";
import type {
  PlaystationGame,
  PlaystationNowPlaying,
  PlaystationPlayingPayload,
  PlaystationPresencePayload,
} from "@/lib/types";

export function requiredNumber(
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

export function requiredText(
  row: Record<string, unknown>,
  field: string,
  context: string,
): string {
  const value = text(row[field]);
  if (!value) throw new Error(`${context} 的 ${field} 必须是非空字符串`);
  return value;
}

export function nullableNumber(
  row: Record<string, unknown>,
  field: string,
  context: string,
): number | null {
  if (!(field in row)) throw new Error(`${context} 缺少 ${field}`);
  if (row[field] == null) return null;
  return requiredNumber(row, field, context);
}

export function nullableText(
  row: Record<string, unknown>,
  field: string,
  context: string,
): string | null {
  if (!(field in row)) throw new Error(`${context} 缺少 ${field}`);
  if (row[field] == null) return null;
  return requiredText(row, field, context);
}

export function requiredBoolean(
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

export function normalizeNowPlaying(value: unknown): PlaystationNowPlaying | null {
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

export function normalizeGame(value: unknown, index: number): PlaystationGame {
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
