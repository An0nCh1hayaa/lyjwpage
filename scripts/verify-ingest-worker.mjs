#!/usr/bin/env node
/** Isolated Worker → Durable Objects SQLite → Next cache + WebSocket verification. Requires Node 24 and pnpm build. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(join(root, 'workers/ingest/package.json'));
const temporary = await mkdtemp(join(tmpdir(), 'lyjw-ingest-'));
const children = [];
const logs = [];
let socket;
const secret = 'local-token-usage-verification';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
function start(command, args, env = {}) {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, WRANGLER_LOG_PATH: join(temporary, 'wrangler.log'), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const [workerPort, sitePort] = await Promise.all([port(), port()]);
  const worker = `http://127.0.0.1:${workerPort}`;
  const site = `http://127.0.0.1:${sitePort}`;
  const vars = {
    NEXT_PUBLIC_BACKEND_URL: worker, STORAGE_PREFIX: 'isolated-verify', TELEMETRY_INGEST_SECRET: secret, STATE_IMPORT_SECRET: `${secret}-import`,
    SITE_URL: site, ALLOWED_ORIGINS: '',
    R2_PUBLIC_BASE_URL: '', EMBY_PUBLIC_URL: '',
  };
  // Config lives outside the checkout so Wrangler cannot load real .dev.vars or production bindings.
  const config = {
    name: 'isolated-ingest', main: join(root, 'workers/ingest/src/index.ts'),
    compatibility_date: '2025-02-14', compatibility_flags: ['nodejs_compat', 'nodejs_compat_populate_process_env'],
    vars,
    alias: Object.fromEntries(['storage-driver'].map(name => [`@/lib/${name}`, join(root, `workers/ingest/src/${name}.ts`)])),
    durable_objects: { bindings: [
      { name: 'LIVE_PUSH', class_name: 'LivePushRoom' },
      { name: 'ONLINE_COUNTER', class_name: 'OnlineCounterRoom' },
      { name: 'STATE', class_name: 'StateHub' },
    ] },
    migrations: [
      { tag: 'v1', new_sqlite_classes: ['LivePushRoom'] },
      { tag: 'v2', new_sqlite_classes: ['OnlineCounterRoom'] },
      { tag: 'v3', new_sqlite_classes: ['StateHub'] },
    ],
    r2_buckets: [{ binding: 'IMAGES', bucket_name: 'isolated-images' }],
  };
  const configPath = join(temporary, 'wrangler.json');
  await writeFile(configPath, JSON.stringify(config));
  const workerChild = start(process.execPath, [require.resolve('wrangler'), 'dev', '--config', configPath, '--port', String(workerPort), '--test-scheduled', '--persist-to', join(temporary, 'state')]);
  const notices = [];
  const mockSite = httpServer((request, response) => {
    let body = ''; request.on('data', chunk => body += chunk);
    request.on('end', () => { notices.push(JSON.parse(body)); response.setHeader('content-type', 'application/json'); response.end('{"ok":true}'); });
  });
  mockSite.listen(sitePort, '127.0.0.1');
  children.push({ kill: () => mockSite.close(), exitCode: 0 });
  await eventually(async () => assert.equal((await fetch(`${worker}/count`)).status, 200));
  assert.deepEqual(await (await fetch(`${worker}/count`)).json(), { ok: true, connections: 0, online: 0 });
  assert.equal((await post(worker, '/api/ingest/homepod', {})).status, 503);
  assert.equal((await post(worker, '/api/internal/storage/import', { entries: [], finalize: true }, `${secret}-import`)).status, 200);
  // 「此刻在线」那条：接进来立刻广播人数，/count 的 online 跟着变；它不该带起最近在听的刷新
  const onlineSocket = new WebSocket(`${worker.replace('http:', 'ws:')}/online/ws`);
  const onlineMessages = [];
  onlineSocket.addEventListener('message', e => onlineMessages.push(JSON.parse(e.data)));
  await once(onlineSocket, 'open');
  await eventually(async () => assert.deepEqual(onlineMessages.at(-1), { online: 1 }));
  assert.deepEqual(await (await fetch(`${worker}/count`)).json(), { ok: true, connections: 0, online: 1 });
  onlineSocket.close();
  await eventually(async () => assert.deepEqual(await (await fetch(`${worker}/count`)).json(), { ok: true, connections: 0, online: 0 }));
  console.log('PASS: /online/ws counts visible pages separately; /count answers both numbers');
  const events = [];
  socket = new WebSocket(`${worker.replace('http:', 'ws:')}/ws`);
  socket.addEventListener('message', e => { if (e.data !== 'pong') events.push(JSON.parse(e.data)); });
  await once(socket, 'open');
  async function post(base, path, body, token = secret) {
    return fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  }
  assert.equal((await post(worker, '/publish', { type: 'presence', payload: null })).status, 404);
  assert.equal((await post(worker, '/api/ingest/homepod', {}, 'wrong')).status, 401);
  assert.equal((await post(worker, '/api/ingest/constructor', {})).status, 404);
  const invalidEnvelope = await post(worker, '/api/ingest/mac', {});
  assert.equal(invalidEnvelope.status, 400);
  assert.deepEqual(await invalidEnvelope.json(), { ok: false, error: '上报数据无效或处理失败' });
  const invalidJson = await fetch(`${worker}/api/ingest/mac`, {
    method: 'POST', headers: { authorization: `Bearer ${secret}` },
    body: '{"private-marker":',
  });
  assert.equal(invalidJson.status, 400);
  assert.deepEqual(await invalidJson.json(), { ok: false, error: '上报数据无效或处理失败' });
  assert.equal(invalidJson.headers.get('cache-control'), 'no-store');
  async function nowPlaying() {
    return (await (await fetch(`${worker}/api/status/listening/now`)).json()).data?.music?.title;
  }
  for (const title of ['isolated-first', 'isolated-second']) {
    const body = { entityId: 'media_player.isolated', state: 'playing', title, positionMs: 0, durationMs: 3600000, observedAt: Date.now() };
    assert.equal((await post(worker, '/api/ingest/homepod', body)).status, 202);
    await eventually(async () => assert.equal(await nowPlaying(), title));
    await eventually(async () => assert.ok(events.some(e => e.type === 'listening-now' && e.payload.music?.title === title)));
  }
  await eventually(async () => assert.ok(notices.some(n => n.tags?.includes('listening-now'))));
  await sleep(200);
  const homePodNotices = notices.length;
  await post(worker, '/api/ingest/homepod', { entityId: 'media_player.isolated', state: 'playing', title: 'isolated-second', positionMs: 2000, durationMs: 3600000, observedAt: Date.now() });
  await sleep(200);
  assert.equal(notices.length, homePodNotices, 'HomePod position heartbeat must not invalidate page');
  console.log('PASS: Worker write → Durable Object SQLite → /api/revalidate → direct Worker status; WebSocket receives both updates');
  const response = await post(worker, '/api/ingest/mac', { version: 4, heartbeatAt: Date.now(), presence: 'online', activeModules: ['timezone'], modules: { timezone: { identifier: 'Asia/Singapore', secondsFromGMT: 28800 } } });
  assert.equal(response.status, 202);
  await eventually(async () => assert.ok(notices.some(n => n.tags?.includes('timezone'))));
  const before = notices.length;
  assert.equal((await post(worker, '/api/ingest/mac', { version: 4, heartbeatAt: Date.now(), presence: 'online', activeModules: ['timezone'], modules: {} })).status, 202);
  await sleep(300);
  assert.equal(notices.length, before, 'Pure heartbeat must not invalidate page');
  const home = await (await fetch(`${worker}/api/home`)).json();
  assert.equal(home.timezone.ok, true);
  assert.equal((await fetch(`${worker}/api/internal/storage`)).status, 404);
  assert.equal((await post(worker, '/api/internal/storage', { commands: [] })).status, 405);
  assert.equal((await fetch(`${worker}/api/status/listening/now`, { headers: { Origin: 'http://localhost:3000' } })).headers.get('access-control-allow-origin'), 'http://localhost:3000');
  assert.equal(JSON.stringify(home).includes('musicUserToken'), false);
  assert.equal(JSON.stringify(home).includes('developerToken'), false);
  console.log('PASS: public snapshot, CORS, private storage removed, heartbeat does not invalidate HTML');
  const coding = start(process.execPath, [join(root, 'scripts/verify-coding-usage.mjs'), '--base', worker, '--ingest', worker, '--storage-prefix', 'isolated-verify']);
  const [codingExit] = await once(coding, 'exit');
  assert.equal(codingExit, 0, logs.join(''));
  console.log('PASS: coding usage, limits, history and invalid-envelope regression');
  const concurrent = Array.from({ length: 8 }, (_, i) => post(worker, '/api/ingest/mac', {
    version: 4, heartbeatAt: Date.now(), presence: 'online', activeModules: ['timezone'],
    modules: i % 2 ? {} : { timezone: { identifier: 'Asia/Singapore', secondsFromGMT: 28800 } },
  }));
  assert.ok((await Promise.all(concurrent)).every(response => response.status === 202));
  assert.equal((await (await fetch(`${worker}/api/home`)).json()).timezone.ok, true);
  console.log('PASS: concurrent heartbeats preserve a separately updated module');
  socket.close();
  const exited = once(workerChild, 'exit');
  workerChild.kill('SIGTERM');
  await exited;
  start(process.execPath, [require.resolve('wrangler'), 'dev', '--config', configPath, '--port', String(workerPort), '--test-scheduled', '--persist-to', join(temporary, 'state')]);
  await eventually(async () => assert.equal(await nowPlaying(), 'isolated-second'));
  assert.equal((await (await fetch(`${worker}/api/home`)).json()).timezone.ok, true);
  console.log('PASS: restart preserves initialized state and snapshots');
  assert.equal(logs.some(line => /Cannot perform I\/O|\[storage\]|\[revalidate\]|Uncaught/.test(line)), false, logs.join(''));
} catch (error) {
  console.error(logs.join('').slice(-12000));
  throw error;
} finally {
  socket?.close();
  for (const child of children.reverse()) child.kill('SIGTERM');
  await Promise.all(children.map(child => child.exitCode === null ? Promise.race([once(child, 'exit'), sleep(3000).then(() => child.kill('SIGKILL'))]) : undefined));
  await rm(temporary, { recursive: true, force: true });
}
