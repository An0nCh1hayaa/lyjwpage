import assert from "node:assert/strict";
import test from "node:test";

import { getStored, readChargerState } from "@/lib/charger-store";
import { installRedisForTests, resetRedisForTests } from "@/lib/redis";
import { FakeRedis } from "@/lib/testing/fake-redis";
import { prepareHeartbeat } from "@ingest/stores/charger-store";
import { K_HISTORY, K_LATEST } from "@shared/charger-store";

test("读取隐藏过期充电曲线，实际删除仅由 Worker 心跳完成", async () => {
  const redis = new FakeRedis();
  installRedisForTests(redis);
  try {
    const now = Date.now();
    await redis.set(K_LATEST, JSON.stringify({
      status: { connected: false },
      receivedAt: now,
      disconnectedAt: now - 31 * 60_000,
    }));
    const sample = JSON.stringify({ t: now - 32 * 60_000, w: 15 });
    await redis.rpush(K_HISTORY, sample);

    assert.deepEqual((await getStored())?.history, []);
    assert.deepEqual(await redis.lrange(K_HISTORY, 0, -1), [sample]);

    await prepareHeartbeat(now, await readChargerState()).commit();
    assert.deepEqual(await redis.lrange(K_HISTORY, 0, -1), []);
  } finally {
    resetRedisForTests();
  }
});
