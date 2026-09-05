import assert from "node:assert/strict";
import test from "node:test";

import { cached, get, put, remove } from "@/lib/cache";
import { installRedisForTests, key, resetRedisForTests } from "@/lib/redis";
import { FakeRedis } from "@/lib/testing/fake-redis";

test.beforeEach(() => {
  resetRedisForTests();
});

test.afterEach(() => {
  resetRedisForTests();
});

test("get：Redis 可达且说没有时，不退回进程内存副本", async () => {
  const redis = new FakeRedis();
  installRedisForTests(redis);
  await put("k", { n: 1 }, 60_000);
  assert.deepEqual(await get("k"), { n: 1 });

  // 另一个实例清掉了 Redis 里那份（或者整个库被清空）
  await redis.del(key("cache", "k"));
  assert.equal(await get("k"), undefined);
});

test("get：Redis 不可达时才退回进程内存副本", async () => {
  const redis = new FakeRedis();
  installRedisForTests(redis);
  await put("k", { n: 2 }, 60_000);

  redis.setUnreachable();
  assert.deepEqual(await get("k"), { n: 2 });
});

test("get：写的时候 Redis 拒了、之后又可达，内存里那份仍然作数", async () => {
  const redis = new FakeRedis();
  installRedisForTests(redis);
  redis.setUnreachable();
  await put("k", { n: 3 }, 60_000);

  redis.setUnreachable(false);
  assert.equal(await redis.get(key("cache", "k")), null);
  assert.deepEqual(await get("k"), { n: 3 });
});

test("cached：Redis 拒写时 5 秒负缓存仍然挡住上游", async () => {
  const redis = new FakeRedis();
  installRedisForTests(redis);
  let calls = 0;
  const loader = async () => {
    calls += 1;
    throw new Error("上游挂了");
  };

  redis.setUnreachable();
  await assert.rejects(cached("c-neg", 60_000, loader), /上游挂了/);
  redis.setUnreachable(false);
  await assert.rejects(cached("c-neg", 60_000, loader), /上游挂了/);
  assert.equal(calls, 1);
});

test("remove 之后本进程和 Redis 都读不到", async () => {
  const redis = new FakeRedis();
  installRedisForTests(redis);
  await put("k", "v", 60_000);
  await remove("k");
  assert.equal(await get("k"), undefined);
  assert.equal(await redis.get(key("cache", "k")), null);
});

test("cached：Redis 里被删掉后重新走 loader", async () => {
  const redis = new FakeRedis();
  installRedisForTests(redis);
  let calls = 0;
  const loader = async () => ({ n: ++calls });

  assert.deepEqual(await cached("c-del", 60_000, loader), { n: 1 });
  assert.deepEqual(await cached("c-del", 60_000, loader), { n: 1 });

  await redis.del(key("cache", "c-del"));
  assert.deepEqual(await cached("c-del", 60_000, loader), { n: 2 });
});
