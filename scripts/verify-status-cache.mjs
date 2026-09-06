#!/usr/bin/env node
/** Run against an isolated `next start`, and Worker sharing an isolated Redis. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  ingest: { type: "string", default: "http://127.0.0.1:8787" },
  base: { type: "string", default: "http://127.0.0.1:3212" },
} });
const base = new URL(values.base);
assert.equal(base.protocol, "http:");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(base.hostname), "Only local test servers are allowed");
assert.ok(!base.username && !base.password && !base.search && !base.hash && base.pathname === "/");
const ingest = new URL(values.ingest);
assert.equal(ingest.protocol, "http:");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(ingest.hostname));
assert.ok(!ingest.username && !ingest.password && !ingest.search && !ingest.hash && ingest.pathname === "/");
const secret = "local-status-cache-verification";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path, body, token = secret) {
  return fetch(new URL(path, path.startsWith("/api/ingest/") ? ingest : base), {
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
  return { cache: response.headers.get("x-nextjs-cache"), html: await response.text() };
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

// A second urgent report arrives while nobody is requesting the page.
const second = `cache-verify-B-${Date.now()}`;
assert.equal(await report(second), 202);
// Ingest returns 202; its after() work must finish before testing the next read.
await sleep(500);
const page = await home();
assert.equal(page.cache, "STALE", "Urgent data updates must not evict the prerendered HTML");
assert.ok(page.html.includes(first), "The first visitor receives the previous HTML");
assert.ok(!page.html.includes(second));
assert.equal((await nowPlaying()).music?.title, second, "The first API read must get the new playback state");
console.log("PASS: after an urgent report, HTML serves stale while the first API read is fresh");

await eventually(async () => {
  const refreshed = await home();
  assert.equal(refreshed.cache, "HIT");
  assert.ok(refreshed.html.includes(second), "Background regeneration must include the new playback state");
});
console.log("PASS: background regeneration replaces the HTML with the new state");
