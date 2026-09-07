import { withStorage } from "@/lib/storage";
import { type ChargingDevice, SETTLING_MS, settlingKey } from "@shared/charging-settling";

/** 重开窗口。和推送同时发车，见 lib/live-events 的 fanout */
export function writeSettlingAt(device: ChargingDevice, receivedAt: number): Promise<unknown> {
  return withStorage(
    async (storage) => storage.set(settlingKey(device), String(receivedAt), { ttlMs: SETTLING_MS }),
    null,
  );
}
