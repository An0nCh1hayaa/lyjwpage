import assert from "node:assert/strict";
import test from "node:test";

import { cached, get, put, remove } from "@/lib/cache";
import { installStorageForTests, key, resetStorageForTests } from "@/lib/storage";
import { FakeStorage } from "@/lib/testing/fake-storage";

test.beforeEach(() => {
  resetStorageForTests();
});

test.afterEach(() => {
  resetStorageForTests();
});

test("get：Storage 可达且说没有时，不退回进程内存副本", async () => {
  const storage = new FakeStorage();
  installStorageForTests(storage);
  await put("k", { n: 1 }, 60_000);
  assert.deepEqual(await get("k"), { n: 1 });

  // 另一个实例清掉了 SQLite 里那份（或者整个库被清空）
  await storage.remove(key("cache", "k"));
  assert.equal(await get("k"), undefined);
});

test("get：Storage 不可达时才退回进程内存副本", async () => {
  const storage = new FakeStorage();
  installStorageForTests(storage);
  await put("k", { n: 2 }, 60_000);

  storage.setUnreachable();
  assert.deepEqual(await get("k"), { n: 2 });
});

test("get：写的时候 Storage 拒了、之后又可达，内存里那份仍然作数", async () => {
  const storage = new FakeStorage();
  installStorageForTests(storage);
  storage.setUnreachable();
  await put("k", { n: 3 }, 60_000);

  storage.setUnreachable(false);
  assert.equal(await storage.get(key("cache", "k")), null);
  assert.deepEqual(await get("k"), { n: 3 });
});

test("cached：Storage 拒写时 5 秒负缓存仍然挡住上游", async () => {
  const storage = new FakeStorage();
  installStorageForTests(storage);
  let calls = 0;
  const loader = async () => {
    calls += 1;
    throw new Error("上游挂了");
  };

  storage.setUnreachable();
  await assert.rejects(cached("c-neg", 60_000, loader), /上游挂了/);
  storage.setUnreachable(false);
  await assert.rejects(cached("c-neg", 60_000, loader), /上游挂了/);
  assert.equal(calls, 1);
});

test("remove 之后本进程和 Storage 都读不到", async () => {
  const storage = new FakeStorage();
  installStorageForTests(storage);
  await put("k", "v", 60_000);
  await remove("k");
  assert.equal(await get("k"), undefined);
  assert.equal(await storage.get(key("cache", "k")), null);
});

test("cached：Storage 里被删掉后重新走 loader", async () => {
  const storage = new FakeStorage();
  installStorageForTests(storage);
  let calls = 0;
  const loader = async () => ({ n: ++calls });

  assert.deepEqual(await cached("c-del", 60_000, loader), { n: 1 });
  assert.deepEqual(await cached("c-del", 60_000, loader), { n: 1 });

  await storage.remove(key("cache", "c-del"));
  assert.deepEqual(await cached("c-del", 60_000, loader), { n: 2 });
});
