#!/usr/bin/env node
/** Run against an isolated `next start`, and Worker using an isolated Durable Object. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  ingest: { type: "string", default: "http://127.0.0.1:8787" },
  "secret-file": { type: "string" },
  base: { type: "string", default: "http://127.0.0.1:3212" },
} });
const base = new URL(values.base);
assert.ok(["http:", "https:"].includes(base.protocol));
assert.ok(["localhost", "127.0.0.1", "[::1]", "lyjwpage-do-test.vercel.app"].includes(base.hostname), "Only local test servers are allowed");
assert.ok(!base.username && !base.password && !base.search && !base.hash && base.pathname === "/");
const ingest = new URL(values.ingest);
assert.ok(["http:", "https:"].includes(ingest.protocol));
assert.ok(["localhost", "127.0.0.1", "[::1]", "ingest-do-test.lyjw.workers.dev"].includes(ingest.hostname));
assert.ok(!ingest.username && !ingest.password && !ingest.search && !ingest.hash && ingest.pathname === "/");
const secret = values["secret-file"] ? JSON.parse(await readFile(values["secret-file"], "utf8")).TELEMETRY_INGEST_SECRET : "local-status-cache-verification";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path, body, token = secret) {
  return fetch(new URL(path, path.startsWith("/api/ingest/") || path.startsWith("/api/status/") ? ingest : base), {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : {
      "content-type": "application/json", authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
}

async function home() {
  const response = await request("/");
  assert.equal(response.status, 200);
  return { cache: response.headers.get("x-nextjs-cache") ?? response.headers.get("x-vercel-cache"), html: await response.text() };
}

async function nowPlaying() {
  const response = await request("/api/status/listening/now");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const envelope = await response.json();
  assert.equal(envelope.ok, true);
  return envelope.data;
}

async function report(title, token = secret) {
  const response = await request("/api/ingest/homepod", {
    entityId: "media_player.cache_verification", state: "playing", title,
    positionMs: 0, durationMs: 3_600_000, observedAt: Date.now(),
  }, token);
  await response.text();
  return response.status;
}

async function eventually(check) {
  const deadline = Date.now() + 20_000;
  let failure;
  do {
    try { return await check(); } catch (error) { failure = error; }
    await sleep(100);
  } while (Date.now() < deadline);
  throw failure;
}

// Read the real build output: catches API tags propagated by ANY nested page cache.
const manifest = JSON.parse(await readFile(".next/prerender-manifest.json", "utf8"));
assert.equal(manifest.routes["/"].initialRevalidateSeconds, 600);
assert.equal(manifest.routes["/"].initialExpireSeconds, 604800);
const meta = JSON.parse(await readFile(".next/server/app/index.meta", "utf8"));
const tags = meta.headers["x-next-cache-tags"].split(",");
assert.ok(tags.includes("page:listening-now"), "Home must include the page-scoped nested playing cache");
assert.ok(tags.includes("page:charger") && tags.includes("page:trophies"));
assert.ok(!tags.some((tag) => tag.startsWith("api:")), "No API tag may propagate into the HTML cache");
console.log("PASS: production HTML has page tags only, with 10m revalidate / 7d expire");

assert.equal(await report("unauthorized", "wrong-secret"), 401);
const first = `cache-verify-A-${Date.now()}`;
assert.equal(await report(first), 202);
await eventually(async () => assert.equal((await nowPlaying()).music?.title, first));
await eventually(async () => {
  const page = await home();
  assert.equal(page.cache, "HIT");
  assert.ok(page.html.includes(first));
});

// A second content report arrives while nobody is requesting the page.
const second = `cache-verify-B-${Date.now()}`;
assert.equal(await report(second), 202);
// Ingest returns 202; its waitUntil work must finish before testing the next read.
await sleep(500);
const page = await home();
if (base.hostname.endsWith(".vercel.app")) {
  // Vercel 的边缘 HIT 不等于内部 tag 未标 stale；下面直接检查旧 HTML 和后台替换。
  assert.ok(["HIT", "STALE"].includes(page.cache), "Existing HTML must remain cacheable");
} else assert.equal(page.cache, "STALE", "Content updates must not evict the prerendered HTML");
assert.ok(page.html.includes(first), "The first visitor receives the previous HTML");
assert.ok(!page.html.includes(second));
assert.equal((await nowPlaying()).music?.title, second, "The first API read must get the new playback state");
console.log("PASS: after an content report, HTML serves stale while the first API read is fresh");

await eventually(async () => {
  const refreshed = await home();
  assert.equal(refreshed.cache, "HIT");
  assert.ok(refreshed.html.includes(second), "Background regeneration must include the new playback state");
});
console.log("PASS: background regeneration replaces the HTML with the new state");
