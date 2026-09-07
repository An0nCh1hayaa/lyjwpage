import { writeLiveness } from "@api/stores/reporter-liveness";
import assert from "node:assert/strict";
import test from "node:test";

import { heartbeatWindowMs } from "@/lib/freshness";
import { installStorageForTests, resetStorageForTests } from "@/lib/storage";
import {
  nextLiveness,
  offlineByLiveness,
  readLiveness,
} from "@/lib/reporter-liveness";
import { FakeStorage } from "@/lib/testing/fake-storage";

test.beforeEach(() => {
  resetStorageForTests();
});

test.afterEach(() => {
  resetStorageForTests();
});

test("从没见过上报器时是 lastSeenAt 0", async () => {
  installStorageForTests(new FakeStorage());
  assert.deepEqual(await readLiveness(), { lastSeenAt: 0, declaredOffline: false });
});

test("writeLiveness 之后 readLiveness 读到同一份", async () => {
  installStorageForTests(new FakeStorage());
  const live = { lastSeenAt: 42, declaredOffline: false };
  await writeLiveness(live);
  assert.deepEqual(await readLiveness(), live);
});

test("Storage 不可达时存活仍留在内存里", async () => {
  const storage = new FakeStorage();
  installStorageForTests(storage);
  await writeLiveness({ lastSeenAt: 42, declaredOffline: false });
  storage.setUnreachable();
  await writeLiveness({ lastSeenAt: 99, declaredOffline: true });
  assert.deepEqual(await readLiveness(), { lastSeenAt: 99, declaredOffline: true });
});

test("nextLiveness 离线声明翻转才算 flipped", () => {
  const same = nextLiveness({ lastSeenAt: 1, declaredOffline: false }, { offline: false, at: 2 });
  assert.equal(same.flipped, false);
  assert.deepEqual(same.next, { lastSeenAt: 2, declaredOffline: false });

  const flipped = nextLiveness({ lastSeenAt: 1, declaredOffline: false }, { offline: true, at: 3 });
  assert.equal(flipped.flipped, true);
  assert.deepEqual(flipped.next, { lastSeenAt: 3, declaredOffline: true });
});

test("亲口离线或心跳窗口过了才算掉线", () => {
  const window = heartbeatWindowMs();
  assert.equal(offlineByLiveness({ lastSeenAt: 1000, declaredOffline: false }, 1000), false);
  assert.equal(offlineByLiveness({ lastSeenAt: 1000, declaredOffline: false }, 1000 + window), false);
  assert.equal(
    offlineByLiveness({ lastSeenAt: 1000, declaredOffline: false }, 1000 + window + 1),
    true,
  );
  assert.equal(offlineByLiveness({ lastSeenAt: 1000, declaredOffline: true }, 1000), true);
  assert.equal(offlineByLiveness({ lastSeenAt: 0, declaredOffline: false }, 1000), true);
});
