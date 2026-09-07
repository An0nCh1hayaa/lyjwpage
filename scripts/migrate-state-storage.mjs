#!/usr/bin/env node
/** One-time, operator-run migration. Redis is a development dependency only. Never prints values. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import Redis from "ioredis";

const { values } = parseArgs({ options: {
  export: { type: "string" }, import: { type: "string" }, initialize: { type: "boolean" },
} });
const prefix = process.env.STORAGE_PREFIX ?? process.env.REDIS_PREFIX ?? "lyjwpage";
assert.ok(/^[a-zA-Z0-9:_-]+$/.test(prefix), "Invalid prefix");
if (values.export) {
  assert.ok(process.env.REDIS_URL, "REDIS_URL is required for export");
  const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, retryStrategy: null, connectTimeout: 5000, commandTimeout: 10000, maxRetriesPerRequest: 0 });
  redis.on("error", () => {});
  try {
    await redis.connect();
    const keys = new Set();
    let cursor = "0";
    do {
      const result = await redis.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 100);
      cursor = result[0];
      for (const key of result[1]) keys.add(key);
    } while (cursor !== "0");
    const entries = [];
    const names = [...keys];
    // 按小批次流水读取，切换期间无需逐键等待数百次网络往返。
    for (let offset = 0; offset < names.length; offset += 50) {
      const batch = names.slice(offset, offset + 50);
      const types = await redis.pipeline(batch.map(key => ["type", key])).exec();
      assert.ok(types && types.every(([error]) => !error), "Export type lookup failed");
      const pipe = redis.pipeline();
      const selected = [];
      for (let index = 0; index < batch.length; index++) {
        const kind = types[index][1];
        if (kind === "none") continue;
        assert.ok(["string", "list", "hash"].includes(kind), `Unsupported entry type: ${kind}`);
        const key = batch[index];
        selected.push({ key, kind });
        pipe.pttl(key);
        if (kind === "string") pipe.get(key);
        if (kind === "hash") pipe.hgetall(key);
        if (kind === "list") pipe.lrange(key, 0, -1);
      }
      if (!selected.length) continue;
      const observedAt = Date.now();
      const result = await pipe.exec();
      assert.ok(result && result.every(([error]) => !error), "Export read failed");
      selected.forEach(({ key, kind }, index) => {
        const ttl = Number(result[index * 2][1]);
        if (ttl !== -2) entries.push({ key, kind, value: result[index * 2 + 1][1], expiresAt: ttl < 0 ? null : observedAt + ttl });
      });
    }
    // The new module store has one field table, without the old redundant JSON blob.
    const blobKey = `${prefix}:telemetry:state`;
    const fieldsKey = `${prefix}:telemetry:fields`;
    const blob = entries.find(entry => entry.key === blobKey);
    let fields = entries.find(entry => entry.key === fieldsKey);
    if (blob?.kind === "string") {
      const baseline = Object.fromEntries(Object.entries(JSON.parse(blob.value)).map(([key, value]) => [key, JSON.stringify(value)]));
      if (fields) fields.value = { ...baseline, ...fields.value };
      else { fields = { key: fieldsKey, kind: "hash", value: baseline, expiresAt: null }; entries.push(fields); }
    }
    const snapshot = { version: 1, prefix, exportedAt: Date.now(), entries: entries.filter(entry => entry.key !== blobKey) };
    await writeFile(values.export, JSON.stringify(snapshot), { mode: 0o600, flag: "wx" });
    console.log(`Exported ${snapshot.entries.length} entries to the private snapshot file.`);
  } finally { redis.disconnect(); }
} else if (values.import || values.initialize) {
  assert.ok(process.env.STATE_SERVICE_URL && process.env.STATE_IMPORT_SECRET, "STATE_SERVICE_URL and STATE_IMPORT_SECRET are required");
  const url = new URL("/api/internal/storage/import", process.env.STATE_SERVICE_URL);
  assert.ok(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)), "HTTPS required");
  const snapshot = values.import ? JSON.parse(await readFile(values.import, "utf8")) : { version: 1, prefix, entries: [] };
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.prefix, prefix);
  assert.ok(Array.isArray(snapshot.entries));
  let imported = 0;
  const send = async (entries, finalize = false) => {
    const body = JSON.stringify({ entries, finalize });
    assert.ok(Buffer.byteLength(body) <= 4 * 1024 * 1024, "Entry exceeds import request limit");
    const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${process.env.STATE_IMPORT_SECRET}`, "content-type": "application/json" }, body, redirect: "error", signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200, `Import returned ${response.status}`);
    imported += (await response.json()).imported;
  };
  let batch = [];
  let bytes = 0;
  for (const entry of snapshot.entries) {
    assert.ok(entry.key.startsWith(`${prefix}:`));
    const size = Buffer.byteLength(JSON.stringify(entry));
    if (batch.length && (bytes + size > 3 * 1024 * 1024 || batch.length >= 100)) { await send(batch); batch = []; bytes = 0; }
    batch.push(entry); bytes += size;
  }
  if (batch.length) await send(batch);
  await send([], true);
  console.log(`Imported ${imported} entries; state service initialized.`);
} else {
  console.log("Export: node --env-file=<source.env> scripts/migrate-state-storage.mjs --export <private-snapshot.json>");
  console.log("Import: node --env-file=<target.env> scripts/migrate-state-storage.mjs --import <private-snapshot.json>");
  console.log("Empty test environment: node --env-file=<target.env> scripts/migrate-state-storage.mjs --initialize");
}
