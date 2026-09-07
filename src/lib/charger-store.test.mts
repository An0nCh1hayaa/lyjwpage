import assert from "node:assert/strict";
import test from "node:test";

import { getStored, readChargerState } from "@/lib/charger-store";
import { installStorageForTests, resetStorageForTests } from "@/lib/storage";
import { FakeStorage } from "@/lib/testing/fake-storage";
import { prepareHeartbeat } from "@ingest/stores/charger-store";
import { K_HISTORY, K_LATEST } from "@shared/charger-store";

test("读取隐藏过期充电曲线，实际删除仅由 Worker 心跳完成", async () => {
  const storage = new FakeStorage();
  installStorageForTests(storage);
  try {
    const now = Date.now();
    await storage.set(K_LATEST, JSON.stringify({
      status: { connected: false },
      receivedAt: now,
      disconnectedAt: now - 31 * 60_000,
    }));
    const sample = JSON.stringify({ t: now - 32 * 60_000, w: 15 });
    await storage.append(K_HISTORY, sample);

    assert.deepEqual((await getStored())?.history, []);
    assert.deepEqual(await storage.listRange(K_HISTORY, 0, -1), [sample]);

    await prepareHeartbeat(now, await readChargerState()).commit();
    assert.deepEqual(await storage.listRange(K_HISTORY, 0, -1), []);
  } finally {
    resetStorageForTests();
  }
});
