#!/usr/bin/env node
/** Isolated Worker → Redis → Next cache + WebSocket verification. Requires redis-server and pnpm build. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import Redis from 'ioredis';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(join(root, 'workers/ingest/package.json'));
const temporary = await mkdtemp(join(tmpdir(), 'lyjw-ingest-'));
const children = [];
const logs = [];
let redis;
let socket;
const secret = 'isolated-ingest-verification';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
function start(command, args, env = {}) {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(data.toString()));
  return child;
}
async function eventually(check) {
  const deadline = Date.now() + 45_000;
  let failure;
  do {
    try { return await check(); } catch (error) { failure = error; }
    await sleep(100);
  } while (Date.now() < deadline);
  throw failure;
}
try {
  const [redisPort, workerPort, sitePort] = await Promise.all([port(), port(), port()]);
  const worker = `http://127.0.0.1:${workerPort}`;
  const site = `http://127.0.0.1:${sitePort}`;
  const redisUrl = `redis://127.0.0.1:${redisPort}`;
  start('redis-server', ['--bind', '127.0.0.1', '--port', String(redisPort), '--save', '', '--appendonly', 'no', '--dir', temporary]);
  redis = new Redis(redisUrl, { retryStrategy: () => 100 }); redis.on('error', () => {});
  await eventually(() => redis.ping());
  const vars = {
    REDIS_URL: redisUrl, REDIS_PREFIX: 'isolated-ingest', TELEMETRY_INGEST_SECRET: secret,
    SITE_URL: site, ALLOWED_ORIGINS: '',
    R2_PUBLIC_BASE_URL: '', EMBY_PUBLIC_URL: '',
  };
  // Config lives outside the checkout so Wrangler cannot load real .dev.vars or production bindings.
  const config = {
    name: 'isolated-ingest', main: join(root, 'workers/ingest/src/index.ts'),
    compatibility_date: '2025-02-14', compatibility_flags: ['nodejs_compat', 'nodejs_compat_populate_process_env'],
    vars,
    alias: Object.fromEntries(['redis-driver'].map(name => [`@/lib/${name}`, join(root, `workers/ingest/src/${name}.ts`)])),
    durable_objects: { bindings: [{ name: 'LIVE_PUSH', class_name: 'LivePushRoom' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['LivePushRoom'] }],
    r2_buckets: [{ binding: 'IMAGES', bucket_name: 'isolated-images' }],
  };
  const configPath = join(temporary, 'wrangler.json');
  await writeFile(configPath, JSON.stringify(config));
  start(process.execPath, [require.resolve('wrangler'), 'dev', '--config', configPath, '--port', String(workerPort), '--test-scheduled', '--persist-to', join(temporary, 'state')]);
  start(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'start', '-p', String(sitePort)], {
    ...vars, VERCEL: '', NEXT_PUBLIC_LIVE_PUSH_URL: '', NEXT_PUBLIC_ONLINE_COUNTER_URL: '', GITHUB_TOKEN: '',
  });
  await eventually(async () => assert.equal((await fetch(`${worker}/count`)).status, 200));
  await eventually(async () => assert.equal((await fetch(`${site}/api/status/listening/now`)).status, 200));
  const refreshKey = 'isolated-ingest:cache:apple-music:recent:refresh:v1';
  assert.equal((await fetch(`${worker}/__scheduled`)).status, 200);
  assert.equal(await redis.get(refreshKey), null, 'No viewers: scheduled refresh must not run');
  const events = [];
  socket = new WebSocket(`${worker.replace('http:', 'ws:')}/ws`);
  socket.addEventListener('message', e => events.push(JSON.parse(e.data)));
  await once(socket, 'open');
  await eventually(async () => assert.equal(await redis.get(refreshKey), '1'));
  console.log('PASS: site reads do not refresh; scheduled refresh skips no-viewer periods; WebSocket starts the two-minute gate');
  async function post(base, path, body, token = secret) {
    return fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  }
  assert.equal((await post(site, '/api/ingest/mac', {})).status, 404);
  assert.equal((await post(worker, '/publish', { type: 'presence', payload: null })).status, 404);
  assert.equal((await post(worker, '/api/ingest/homepod', {}, 'wrong')).status, 401);
  assert.equal((await post(worker, '/api/ingest/constructor', {})).status, 404);
  assert.equal((await post(worker, '/api/ingest/mac', {})).status, 400);
  assert.equal((await post(site, '/api/revalidate', { tags: ['server'] }, 'wrong')).status, 401);
  assert.equal((await post(site, '/api/revalidate', { tags: ['not-a-status'] })).status, 400);
  console.log('PASS: Worker auth, source lookup, payload validation; revalidate auth and tag allowlist');
  async function nowPlaying() {
    return (await (await fetch(`${site}/api/status/listening/now`)).json()).data?.music?.title;
  }
  for (const title of ['isolated-first', 'isolated-second']) {
    const body = { entityId: 'media_player.isolated', state: 'playing', title, positionMs: 0, durationMs: 3600000, observedAt: Date.now() };
    assert.equal((await post(worker, '/api/ingest/homepod', body)).status, 202);
    await eventually(async () => assert.equal(JSON.parse(await redis.get('isolated-ingest:homepod:nowPlaying')).music.title, title));
    await eventually(async () => assert.equal(await nowPlaying(), title));
    await eventually(async () => assert.ok(events.some(e => e.type === 'listening-now' && e.payload.music?.title === title)));
  }
  console.log('PASS: Worker RESP write → real Redis → /api/revalidate → cached Next status; WebSocket receives both updates');
  const response = await post(worker, '/api/ingest/mac', { version: 4, heartbeatAt: Date.now(), presence: 'online', activeModules: ['timezone'], modules: { timezone: { identifier: 'Asia/Singapore', secondsFromGMT: 28800 } } });
  assert.equal(response.status, 202);
  await eventually(async () => assert.ok((await redis.keys('isolated-ingest:telemetry:*')).length));
  console.log('PASS: Mac envelope, hash pipeline, presence fanout');
  assert.equal(logs.some(line => /Cannot perform I\/O|\[redis\]|\[revalidate\]|Uncaught/.test(line)), false, logs.join(''));
} catch (error) {
  console.error(logs.join('').slice(-12000));
  throw error;
} finally {
  socket?.close(); redis?.disconnect();
  for (const child of children.reverse()) child.kill('SIGTERM');
  await Promise.all(children.map(child => child.exitCode === null ? Promise.race([once(child, 'exit'), sleep(3000).then(() => child.kill('SIGKILL'))]) : undefined));
  await rm(temporary, { recursive: true, force: true });
}
