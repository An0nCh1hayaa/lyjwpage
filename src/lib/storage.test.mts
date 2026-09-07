import assert from "node:assert/strict";
import test from "node:test";

import {
  askStorage,
  installStorageForTests,
  key,
  mirrorKey,
  fieldMirror,
  resetStorageForTests,
  tellStorage,
} from "@/lib/storage";
import { FakeStorage } from "@/lib/testing/fake-storage";

test.beforeEach(() => {
  resetStorageForTests();
});

test.afterEach(() => {
  resetStorageForTests();
});

test("askStorage 在 Storage 可达时带回值", async () => {
  const storage = new FakeStorage();
  installStorageForTests(storage);
  await storage.set("k", "v");

  const answered = await askStorage((client) => client.get("k"));
  assert.deepEqual(answered, { reachable: true, value: "v" });
});

test("askStorage 在命令抛错时答不可达", async () => {
  const storage = new FakeStorage();
  installStorageForTests(storage);
  storage.setUnreachable();

  const answered = await askStorage((client) => client.get("k"));
  assert.deepEqual(answered, { reachable: false });
});

test("askStorage 在没注入客户端时答不可达", async () => {
  installStorageForTests(null);
  const answered = await askStorage((client) => client.get("k"));
  assert.deepEqual(answered, { reachable: false });
});

test("tellStorage 可达时返回 true，命令抛错时返回 false", async () => {
  const storage = new FakeStorage();
  installStorageForTests(storage);

  assert.equal(await tellStorage((client) => client.set("k", "v")), true);
  assert.equal(await storage.get("k"), "v");

  storage.setUnreachable();
  assert.equal(await tellStorage((client) => client.set("k", "z")), false);
});

test("mirrorKey 可达时读写走 Storage", async () => {
  const storage = new FakeStorage();
  installStorageForTests(storage);
  const k = key("test", "mirror", "rw");
  const mirror = mirrorKey<{ n: number; at: number }>(["test", "mirror", "rw"], (value) => value.at);

  await mirror.put({ n: 1, at: 10 });
  assert.equal(await storage.get(k), JSON.stringify({ n: 1, at: 10 }));
  assert.deepEqual(await mirror.get(), { n: 1, at: 10 });

  await mirror.drop();
  assert.equal(await storage.get(k), null);
  assert.equal(await mirror.get(), null);
});

test("mirrorKey 不可达时退回内存镜像", async () => {
  const storage = new FakeStorage();
  installStorageForTests(storage);
  const mirror = mirrorKey<{ n: number; at: number }>(
    ["test", "mirror", "memory"],
    (value) => value.at,
  );

  await mirror.put({ n: 1, at: 10 });
  storage.setUnreachable();
  await mirror.put({ n: 2, at: 20 });

  assert.deepEqual(await mirror.get(), { n: 2, at: 20 });
  storage.setUnreachable(false);
  assert.equal(await storage.get(key("test", "mirror", "memory")), JSON.stringify({ n: 1, at: 10 }));
});

test("mirrorKey 写没落进去时挡住 Storage 里的旧值", async () => {
  const storage = new FakeStorage();
  installStorageForTests(storage);
  const mirror = mirrorKey<{ n: number; at: number }>(
    ["test", "mirror", "stale"],
    (value) => value.at,
  );

  await mirror.put({ n: 1, at: 10 });
  storage.setUnreachable();
  await mirror.put({ n: 2, at: 20 });
  storage.setUnreachable(false);

  assert.deepEqual(await mirror.get(), { n: 2, at: 20 });
});

test("fieldMirror 可达时按字段合并进 Storage", async () => {
  const storage = new FakeStorage();
  installStorageForTests(storage);
  type Sample = { song: string | null; alive: boolean; at: number };
  const overlay = fieldMirror<Sample>(["test", "hash"], (value) => value.at);

  await overlay.merge({ song: "a", alive: true, at: 1 }, ["song", "at"]);
  await overlay.merge({ song: "a", alive: false, at: 2 }, ["alive", "at"]);

  assert.deepEqual(await overlay.get(), { song: "a", alive: false, at: 2 });

});

test("fieldMirror 不可达时退回内存镜像", async () => {
  const storage = new FakeStorage();
  installStorageForTests(storage);
  type Sample = { song: string | null; at: number };
  const overlay = fieldMirror<Sample>(
    ["test", "hash-mem"],
    (value) => value.at,
  );

  await overlay.merge({ song: "a", at: 1 }, ["song", "at"]);
  storage.setUnreachable();
  await overlay.merge({ song: "b", at: 2 }, ["song", "at"]);

  assert.deepEqual(await overlay.get(), { song: "b", at: 2 });
});
