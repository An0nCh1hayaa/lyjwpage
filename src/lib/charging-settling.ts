import { withStorage } from "@/lib/storage";
import { type ChargingDevice, SETTLING_MS, settlingKey } from "@shared/charging-settling";

/**
 * 上一次结构变化的时刻，0 表示没有（也包括 SQLite 答不上话）。
 *
 * 读和判断拆开，是为了让这一条能和这封信封的其它读一起发车 —— 从前它夹在
 * 「落库」和「推送」中间，是推送前最后一个白等的往返。调用方在信封解析完就
 * 该调它，揣着 promise 往下走。
 *
 * 结构真变了的话这次读是白读的（那种情况不看窗口），但它和别的读在同一批里，
 * 多花的是 SQLite 的一点点力气，不是一个来回。
 */
export function askSettlingAt(device: ChargingDevice): Promise<number> {
  return withStorage(async (storage) => {
    const raw = await storage.get(settlingKey(device));
    return raw ? Number(raw) || 0 : 0;
  }, 0);
}

/**
 * 这一次要不要推，以及窗口的起点要不要挪到现在。
 *
 * `structuralChanged` 为真时必推，并重开窗口；否则看是否还落在上一次结构变化
 * 的窗口里。
 *
 * SQLite 不可达时 `since` 是 0，于是自动退化成「只在结构变化时推」—— 那正是
 * 没有这套机制时的行为，比在故障期间把每一帧都广播出去要安全，不用特判。
 */
export function settlingDecision(
  structuralChanged: boolean,
  receivedAt: number,
  since: number,
): { publish: boolean; restart: boolean } {
  if (structuralChanged) return { publish: true, restart: true };
  return {
    publish: Boolean(since) && receivedAt - since <= SETTLING_MS,
    restart: false,
  };
}
export { type ChargingDevice } from "@shared/charging-settling";
