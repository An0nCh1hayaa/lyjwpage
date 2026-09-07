import { askStorage, withStorage, type StorageAnswer } from "@/lib/storage";
import type { ChargerSample } from "@/lib/types";
import { type ChargerState, disconnectedHistoryExpired, fallback, K_HISTORY, K_LAST_PUSH, K_LATEST, type Stored } from "@shared/charger-store";

function fromMemory(): Stored | null {
  return fallback.latest
    ? {
      status: fallback.latest,
      receivedAt: fallback.receivedAt,
      disconnectedAt: fallback.disconnectedAt || null,
    }
    : null;
}

async function readLatest(): Promise<Stored | null> {
  const answered = await askStorage((storage) => storage.get(K_LATEST));
  // SQLite 答不上话，只能信内存
  if (!answered.reachable) return fromMemory();

  if (answered.value) {
    let stored: Stored;
    try {
      stored = JSON.parse(answered.value) as Stored;
    } catch {
      // 脏数据按「答不上来」算，不按「没有」—— 否则会连累好好的内存副本
      return fromMemory();
    }
    // 写失败过时内存这份更新，别被 SQLite 里故障前的旧值盖回去
    if (!fallback.persisted && fallback.latest && fallback.receivedAt > stored.receivedAt) {
      return fromMemory();
    }
    const disconnectedAt = stored.status.connected
      ? 0
      : stored.disconnectedAt ?? stored.receivedAt;
    fallback.latest = stored.status;
    fallback.receivedAt = stored.receivedAt;
    fallback.disconnectedAt = disconnectedAt;
    fallback.persisted = true;
    return { ...stored, disconnectedAt: disconnectedAt || null };
  }

  // SQLite 说没有：写进去过就是真被删了
  if (fallback.persisted) {
    fallback.latest = null;
    fallback.receivedAt = 0;
    fallback.disconnectedAt = 0;
    fallback.history.length = 0;
    return null;
  }
  return fromMemory();
}

/**
 * 曲线不比时间戳，比 latest 那份就够 —— 两者同一次写入、同生共死。SQLite 故障
 * 窗里漏掉几个功率点在图上看不出来，为它单独记一套新旧不值当。
 *
 * 裁决和取数分开：两条命令要能和快照那条同时发车（见 readChargerState），
 * 而裁决里要看 `fallback.persisted`，那是快照那条读完才定的 —— 顺序不能靠
 * 「谁先 await」碰运气，只能等两条都回来了再算。
 */
function acceptHistory(answered: StorageAnswer<string[]>): ChargerSample[] {
  if (!answered.reachable) return [...fallback.history];

  if (answered.value.length) {
    const parsed: ChargerSample[] = [];
    for (const item of answered.value) {
      try {
        parsed.push(JSON.parse(item) as ChargerSample);
      } catch {
        // 跳过坏点，不因为一条脏数据丢掉整条曲线
      }
    }
    fallback.history = [...parsed];
    return parsed;
  }

  if (fallback.persisted) {
    fallback.history.length = 0;
    return [];
  }
  return [...fallback.history];
}

function askHistory() {
  return askStorage((storage) => storage.listRange(K_HISTORY, 0, -1));
}

async function readHistory(): Promise<ChargerSample[]> {
  return acceptHistory(await askHistory());
}

/**
 * 这次上报要用到的两份，同时发车。
 *
 * 两条命令写进同一条连接，在网络上是重叠的 —— 一个来回拿回两份，不用真去组
 * pipeline。调用方在信封解析完的那一刻就该调它，然后揣着这个 promise 往下走，
 * 到充电头分支再 await：那样它和状态、存活那两条读也是重叠的。
 */
export async function readChargerState(): Promise<ChargerState> {
  const [previous, history] = await Promise.all([readLatest(), askHistory()]);
  return { previous, history: acceptHistory(history) };
}

export async function getStored() {
  const latest = await readLatest();
  if (!latest) return null;
  let history = await readHistory();
  if (disconnectedHistoryExpired(latest, Date.now()) && history.length) {
    history = [];
  }
  return {
    status: latest.status,
    receivedAt: latest.receivedAt,
    history,
  };
}

/** 最近一次推送的到达时刻，0 表示从没收到过推送 */
export async function lastPushReceivedAt() {
  const raw = await withStorage(async (storage) => storage.get(K_LAST_PUSH), null);
  const fromStorage = raw ? Number(raw) : 0;
  return Math.max(fromStorage || 0, fallback.lastPushAt);
}
export { type ChargerLanding, type ChargerState } from "@shared/charger-store";
