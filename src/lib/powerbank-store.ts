import { askRedis, withRedis } from "@/lib/redis";
import { fallback, K_LAST_PUSH, K_LATEST, type Stored } from "@shared/powerbank-store";

function fromMemory(): Stored | null {
  return fallback.latest
    ? { status: fallback.latest, receivedAt: fallback.receivedAt }
    : null;
}

async function readLatest(): Promise<Stored | null> {
  const answered = await askRedis((redis) => redis.get(K_LATEST));
  // Redis 答不上话，只能信内存
  if (!answered.reachable) return fromMemory();

  if (answered.value) {
    let stored: Stored;
    try {
      stored = JSON.parse(answered.value) as Stored;
    } catch {
      // 脏数据按「答不上来」算，不按「没有」—— 否则会连累好好的内存副本
      return fromMemory();
    }
    // 写失败过时内存这份更新，别被 Redis 里故障前的旧值盖回去
    if (!fallback.persisted && fallback.latest && fallback.receivedAt > stored.receivedAt) {
      return fromMemory();
    }
    fallback.latest = stored.status;
    fallback.receivedAt = stored.receivedAt;
    fallback.persisted = true;
    return stored;
  }

  // Redis 明确说没有：内存那份没落库过才还算数，落过库说明是真被清了
  return fallback.persisted ? null : fromMemory();
}

/**
 * 上一份快照。和充电头那边的 readChargerState 同一个用法：调用方在信封解析完
 * 就发车，和这封的其它读重叠，到充电宝分支再接住。
 */
export function readPowerBankState(): Promise<Stored | null> {
  return readLatest();
}

export async function getStored() {
  const latest = await readLatest();
  return latest ? { status: latest.status, receivedAt: latest.receivedAt } : null;
}

/** 最近一次推送的到达时刻，0 表示从没收到过 */
export async function lastPushReceivedAt() {
  const raw = await withRedis(async (redis) => redis.get(K_LAST_PUSH), null);
  const fromRedis = raw ? Number(raw) : 0;
  return Math.max(fromRedis || 0, fallback.lastPushAt);
}
