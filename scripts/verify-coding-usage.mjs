#!/usr/bin/env node
/** Local, isolated end-to-end verification. Never reads .env or ambient Redis credentials. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import Redis from "ioredis";

const { values } = parseArgs({ options: {
  ingest: { type: "string", default: "http://127.0.0.1:8787" },
  base: { type: "string", default: "http://localhost:3211" },
  "redis-url": { type: "string", default: "redis://127.0.0.1:6389" },
  "redis-prefix": { type: "string" },
  snapshot: { type: "string" },
  help: { type: "boolean" },
} });
if (values.help) {
  console.log("node scripts/verify-coding-usage.mjs --redis-prefix <isolated-dev-prefix> [--snapshot <Mac CLI JSON>] [--base http://localhost:3211] [--ingest http://127.0.0.1:8787] [--redis-url redis://127.0.0.1:6389]");
  console.log("Requires dedicated local Next and Worker servers with the same isolated Redis, and TELEMETRY_INGEST_SECRET=local-token-usage-verification; production services must not be configured. Leaves the input snapshot (or synthetic baseline) installed and restores prior limits.");
  process.exit(0);
}

const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
function localURL(value, protocol) {
  const url = new URL(value);
  assert.equal(url.protocol, protocol, `Only ${protocol} is allowed`);
  assert.ok(localHosts.has(url.hostname), "Only literal localhost targets are allowed");
  assert.ok(!url.username && !url.password && !url.search && !url.hash, "Credentials, query and fragment are forbidden in target URLs");
  return url;
}
const base = localURL(values.base, "http:");
assert.equal(base.pathname, "/", "The HTTP target must be an origin");
const ingest = localURL(values.ingest, "http:");
assert.equal(ingest.pathname, "/");
const redisURL = localURL(values["redis-url"], "redis:");
assert.ok(redisURL.port && redisURL.port !== "6379", "Use an explicit, dedicated Redis port other than 6379");
const prefix = values["redis-prefix"];
assert.ok(prefix && /^[a-zA-Z0-9:_-]+$/.test(prefix) && /(?:^|[-_:])(test|dev|verify)(?:[-_:]|$)/.test(prefix), "Supply an explicit test/dev/verify Redis prefix; production prefixes are forbidden");
const redisKeys = ["usage", "now", "year", "limits"].map((part) => `${prefix}:vibecoding:${part}`);
const secret = "local-token-usage-verification";
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const date = (stamp) => new Date(stamp).toISOString().slice(0, 10);

function fixture() {
  const now = Date.now();
  const collectedAt = new Date(now).toISOString();
  const today = date(now + 8 * 3_600_000);
  const midnight = Date.parse(`${today}T00:00:00Z`);
  const origin = date(midnight - (new Date(midnight).getUTCDay() + 364) * 86_400_000);
  const todayOffset = Math.round((midnight - Date.parse(`${origin}T00:00:00Z`)) / 86_400_000);
  const day = (tokens) => ({ date: today, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: tokens, apiEquivalentCostUSD: tokens / 1_000 });
  const status = { state: "ok", collectedAt, error: null, coverageStart: origin, coverageEnd: today, precision: "measured", costComplete: true };
  const agents = [
    ["claude", "Claude Code", "anthropic"], ["codex", "Codex", "openai"],
    ["cursor", "Cursor", "cursor"], ["grok", "Grok Build", "grok"],
    ["antigravity", "Antigravity", "antigravity"],
  ].map(([id, label, icon]) => ({ id, label, icon, models: [], currentModel: null, topModel: null, today: day(id === "claude" ? 2_000 : 0), usageStatus: { ...status } }));
  agents[2].today = day(500);
  agents[2].usageStatus = { ...status, state: "error", collectedAt: new Date(now - 3_600_000).toISOString(), error: "Verification: cloud temporarily unavailable", precision: "mixed", costComplete: false };
  agents[3].today = null;
  agents[3].usageStatus = { ...status, state: "unavailable", collectedAt: null, coverageStart: null, coverageEnd: null, costComplete: false };
  const days = Array(371).fill(0);
  days[5] = 1_000;
  days[todayOffset] = 2_500;
  return {
    usage: { agents, totals: { inputTokens: 3_500, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0, totalTokens: 3_500, apiEquivalentCostUSD: 3, costComplete: false, activeDays: 2, sessionCount: 4 }, topModels: [{ model: "fixture-model", tokens: 3_500 }], collectedAt },
    now: { agents: agents.map(({ id }) => ({ id, currentModel: id === "claude" ? "fixture-live-model" : null, lastActivityAt: id === "claude" ? collectedAt : null, active: id === "claude" })) },
    year: { origin, days, models: ["fixture-model"], mix: [[5, 0, 1_000], [todayOffset, 0, 2_500]] },
  };
}
const baseline = fixture();
const restore = values.snapshot ? JSON.parse(await readFile(values.snapshot, "utf8")) : baseline;
assert.ok(restore.usage?.agents?.length && restore.now?.agents && restore.year?.days?.length === 371, "Snapshot must be the Mac CLI {usage, now, year} JSON");
const limits = { agents: [
  { id: "claude", plan: { tier: "max", label: "Verification Max" }, limits: [{ key: "claude.primary", usedPercent: 20, windowMinutes: 300 }], limitsError: null },
  { id: "grok", plan: null, limits: [{ key: "grok.primary", usedPercent: 75 }], limitsError: null },
  { id: "limits-only-demo", plan: null, limits: [], limitsError: "Verification: limits unavailable" },
] };

function envelope(snapshot, parts = ["usage", "now", "year"]) {
  const names = { usage: "vibeCodingUsage", now: "vibeCodingNow", year: "vibeCodingYear" };
  return { version: 4, heartbeatAt: Date.now(), presence: "online", activeModules: ["vibeCoding"], modules: Object.fromEntries(parts.map((part) => [names[part], snapshot[part]])) };
}
async function request(path, body, authorization = secret) {
  const response = await fetch(new URL(path, path.startsWith("/api/ingest/") ? ingest : base), {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(authorization ? { authorization: `Bearer ${authorization}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.json() };
}
async function post(path, body, status = 202, authorization = secret) {
  const result = await request(path, body, authorization);
  assert.equal(result.status, status, `${path}: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.ok, status === 202);
}
async function eventually(check, label) {
  const deadline = Date.now() + 30_000;
  let last;
  do {
    try { return await check(); } catch (error) { last = error; }
    await sleep(200);
  } while (Date.now() < deadline);
  throw new Error(`${label} did not converge: ${last?.message}`, { cause: last });
}
async function data(path) {
  const result = await request(path);
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true, JSON.stringify(result.body));
  return result.body.data;
}
async function assertSnapshot(snapshot) {
  return eventually(async () => {
    const [usage, year] = await Promise.all([data("/api/status/vibecoding"), data("/api/status/vibecoding/year")]);
    assert.deepEqual(usage.totals, snapshot.usage.totals);
    assert.deepEqual(usage.topModels, snapshot.usage.topModels.slice(0, 3));
    assert.equal(usage.collectedAt, snapshot.usage.collectedAt);
    for (const row of snapshot.usage.agents) {
      const actual = usage.agents.find(({ id }) => id === row.id);
      assert.ok(actual, `Missing source ${row.id}`);
      assert.deepEqual(actual.today, row.today);
      assert.deepEqual(actual.usageStatus, row.usageStatus);
      const live = snapshot.now.agents.find(({ id }) => id === row.id);
      assert.equal(actual.active, live?.active ?? false);
      assert.equal(actual.currentModel, live?.currentModel ?? row.currentModel);
      assert.equal(actual.lastActivityAt, live?.lastActivityAt ?? null);
    }
    for (const field of ["origin", "days", "models", "mix"]) assert.deepEqual(year[field], snapshot.year[field]);
    return { usage, year };
  }, "Mac snapshot readback");
}

let passed = 0;
function pass(label) { console.log(`PASS ${++passed}: ${label}`); }
const redis = new Redis(redisURL.href, { lazyConnect: true, retryStrategy: null, maxRetriesPerRequest: 0, connectTimeout: 2_000 });
let previous;
let mutated = false;
try {
  await post("/api/ingest/mac", envelope(baseline), 401, null);
  await post("/api/ingest/agents", limits, 401, "wrong-verification-secret");
  pass("Both ingest endpoints enforce authentication");
  await redis.connect();
  previous = await redis.mget(...redisKeys);
  // Only four known coding keys in the explicit isolated prefix. Never FLUSHDB or SCAN.
  await redis.del(...redisKeys);
  mutated = true;
  await post("/api/ingest/agents", limits);
  await eventually(async () => {
    const usage = await data("/api/status/vibecoding");
    assert.equal(usage.totals, null);
    assert.equal(usage.collectedAt, null);
    assert.equal(usage.pushedAt, null);
    assert.deepEqual(usage.agents.map(({ id }) => id).sort(), limits.agents.map(({ id }) => id).sort());
    assert.ok(usage.agents.every(({ today, usageStatus }) => today === null && usageStatus.state === "unavailable"));
    assert.equal(usage.agents.find(({ id }) => id === "claude").limits[0].usedPercent, 20);
  }, "limits-only state");
  assert.ok(await redis.get(redisKeys[3]), "Dev server and script must use the same isolated Redis prefix");
  pass("Limits-only sources render data with unknown totals and today, not zero");

  const old = structuredClone(baseline);
  delete old.usage.agents[0].usageStatus;
  delete old.usage.totals.costComplete;
  await post("/api/ingest/mac", envelope(old, ["usage"]), 400);
  const bad = structuredClone(baseline);
  bad.usage.agents[0].usageStatus.state = "invalid";
  await post("/api/ingest/mac", envelope(bad, ["usage"]), 400);
  const missingToday = structuredClone(baseline);
  delete missingToday.usage.agents[0].today;
  await post("/api/ingest/mac", envelope(missingToday, ["usage"]), 400);
  pass("Old schema, invalid source status and omitted today are rejected");

  await post("/api/ingest/mac", envelope(baseline));
  const initial = await assertSnapshot(baseline);
  assert.equal(initial.usage.agents.find(({ id }) => id === "codex").today.totalTokens, 0);
  assert.equal(initial.usage.agents.find(({ id }) => id === "grok").today, null);
  assert.ok(initial.usage.agents.some(({ id }) => id === "limits-only-demo"));
  pass("Mac usage/now/year survive ingest; zero, unknown, cached error and limits-only rows remain distinct");

  for (const since of [baseline.year.origin, "9999-12-31", "invalid"]) {
    const year = await data(`/api/status/vibecoding/year?since=${since}`);
    assert.equal(year.days.length, 371);
    assert.deepEqual(year.days, baseline.year.days);
    assert.equal("from" in year, false);
    assert.equal("daysPartial" in year, false);
  }
  pass("Year always returns all 371 days and ignores every since value");

  await post("/api/ingest/mac", envelope(baseline));
  await assertSnapshot(baseline);
  pass("Repeated snapshots replace totals and history without accumulating twice");

  const nowOnly = structuredClone(baseline);
  nowOnly.now.agents[0].currentModel = "fixture-next-model";
  nowOnly.now.agents[0].active = false;
  await post("/api/ingest/mac", envelope(nowOnly, ["now"]));
  await assertSnapshot(nowOnly);
  pass("A now-only update preserves cumulative usage and annual history");

  const invalidYear = structuredClone(baseline);
  invalidYear.usage.totals.totalTokens = 999_999;
  invalidYear.year.days.pop();
  const saved = await redis.mget(...redisKeys.slice(0, 3));
  await post("/api/ingest/mac", envelope(invalidYear), 400);
  await sleep(300);
  assert.deepEqual(await redis.mget(...redisKeys.slice(0, 3)), saved, "An invalid later module must not partially write earlier coding modules");
  await assertSnapshot(nowOnly);
  pass("An invalid later year module rejects the entire coding snapshot before writes");

  const backfill = structuredClone(baseline);
  backfill.year.days[5] = 50;
  backfill.year.days[7] = 700;
  backfill.year.mix[0] = [5, 0, 50];
  backfill.year.mix.splice(1, 0, [7, 0, 700]);
  backfill.usage.totals.inputTokens = 3_250;
  backfill.usage.totals.totalTokens = 3_250;
  backfill.usage.totals.activeDays = 3;
  backfill.usage.topModels[0].tokens = 3_250;
  await post("/api/ingest/mac", envelope(backfill));
  await assertSnapshot(backfill);
  const refreshed = await data(`/api/status/vibecoding/year?since=${date(Date.parse(`${baseline.year.origin}T00:00:00Z`) + 300 * 86_400_000)}`);
  assert.equal(refreshed.days[5], 50);
  assert.equal(refreshed.days[7], 700);
  assert.equal(refreshed.days.length, 371);
  pass("Historical corrections can decrease a day and add an old active day through cached status routes");
} finally {
  try {
    if (mutated) {
      // Restore previous state first so a failed input upload also leaves recoverable data.
      await redis.del(...redisKeys);
      for (let index = 0; index < redisKeys.length; index += 1) {
        if (previous[index] !== null) await redis.set(redisKeys[index], previous[index]);
      }
      await post("/api/ingest/mac", envelope(restore));
      await assertSnapshot(restore);
      const originalLimits = previous[3] === null ? {} : JSON.parse(previous[3]).agents;
      await eventually(async () => {
        assert.equal(await redis.get(redisKeys[3]), previous[3], "Restore the exact original limits state");
        const usage = await data("/api/status/vibecoding");
        assert.deepEqual(usage.agents.map(({ id }) => id).sort(), [...new Set([...restore.usage.agents.map(({ id }) => id), ...Object.keys(originalLimits)])].sort());
        for (const row of usage.agents) {
          const expected = originalLimits[row.id];
          assert.equal(row.limitsAt, expected?.pushedAt ?? null);
          assert.deepEqual(row.limits, expected?.limits ?? []);
          assert.deepEqual(row.plan, expected?.plan ?? null);
          assert.equal(row.limitsError, expected?.limitsError ?? null);
        }
      }, "restored limits through cached status route");
      console.log(`RESTORED ${values.snapshot ?? "synthetic baseline"}: ${restore.usage.totals.totalTokens} tokens, ${restore.usage.totals.activeDays} active days, ${restore.year.days.length} year days`);
    }
  } finally {
    redis.disconnect();
  }
}
console.log(`All ${passed} end-to-end checks passed at ${base.origin}, Redis prefix ${prefix}.`);
