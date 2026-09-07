import { DurableObject } from "cloudflare:workers";

import { HANDLERS } from "./ingest-handlers";
import { StateHub } from "./state-hub";
import { STORAGE_MAX_BYTES } from "@shared/storage-contract";
import type { StoredEntry } from "@shared/sqlite-store";

import { refreshRecentlyPlayed } from "./apple-music-recent";

import { ROOM_ID } from "./live-platform";
import { OnlineCounterRoom } from "./online-counter";
import { requestStore, type Env } from "./runtime";

/** 接收所有上报，在 Worker 内写 Storage、广播 WebSocket，再通知 Vercel 缓存失效。 */

export type { Env };
// Durable Object 类必须从入口模块导出，wrangler 按名字找
export { OnlineCounterRoom, StateHub };

const WS_PATH = "/ws";
/** 「此刻在线」的连接。和 /ws 是两个房间、两个口径，见 online-counter.ts */
const ONLINE_WS_PATH = "/online/ws";
const INGEST_PREFIX = "/api/ingest/";

const LOCAL_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;

/*
 * 下面这四个函数和 musickit-token 那个 worker 逐字一样
 * （workers/musickit-token/src/index.ts），改一处记得同步另一处。
 *
 * 没抽成共享包是故意的：域名名单本来就得在每份 wrangler.toml 里各配一次，
 * 抽包省不掉那份重复，却要多一个包和一层依赖解析。
 */

function getAllowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * 允许 `https://*.vercel.app` 这样的后缀通配。
 *
 * Vercel 的预览域名每次部署都换一个（`lyjwpage-<hash>-....vercel.app`），
 * 只做全等匹配的话，预览环境永远连不上。
 *
 * 按 hostname 的后缀比，不是按字符串包含 —— 后者会把
 * `https://vercel.app.evil.com` 也放进来。
 */
function originMatches(origin: string, pattern: string): boolean {
  if (origin === pattern) return true;
  if (!pattern.includes("*")) return false;

  const wildcard = pattern.match(/^(https?:)\/\/\*\.(.+)$/);
  if (!wildcard) return false;
  const [, protocol, suffix] = wildcard;

  try {
    const url = new URL(origin);
    return url.protocol === protocol && url.hostname.endsWith(`.${suffix}`);
  } catch {
    return false;
  }
}

function isAllowedOriginValue(origin: string, allowed: string[]): boolean {
  if (LOCAL_ORIGIN_RE.test(origin)) return true;
  return allowed.some((pattern) => originMatches(origin, pattern));
}

/**
 * 没配 ALLOWED_ORIGINS 就不限制 —— `wrangler dev` 不配也要能跑，而 localhost
 * 本来就始终放行。**配了之后，不带 Origin 头一律拒绝**：浏览器发 WebSocket
 * 握手时一定带这个头，所以卡死它对真实访客零代价，却堵上了「curl 不带头就
 * 绕过白名单」这个口子。
 */
function isAllowedOrigin(request: Request, env: Env): boolean {
  const allowed = getAllowedOrigins(env);
  if (allowed.length === 0) return true;
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  return isAllowedOriginValue(origin, allowed);
}

function getCorsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers();
  const origin = request.headers.get("Origin");
  const allowed = getAllowedOrigins(env);
  if (origin && (allowed.length === 0 || isAllowedOriginValue(origin, allowed))) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  } else if (allowed.length === 0) {
    headers.set("Access-Control-Allow-Origin", "*");
  }
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Access-Control-Max-Age", "86400");
  return headers;
}

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function secretMatches(provided: string, expected: string): boolean {
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function getRoom(env: Env): DurableObjectStub<LivePushRoom> {
  return env.LIVE_PUSH.get(env.LIVE_PUSH.idFromName(ROOM_ID));
}

function getOnlineRoom(env: Env): DurableObjectStub<OnlineCounterRoom> {
  return env.ONLINE_COUNTER.get(env.ONLINE_COUNTER.idFromName(ROOM_ID));
}

/**
 * 两个人头数一起回答。`connections` 是开着的页面（含后台标签页），`online` 是
 * 此刻可见的页面；三个上报器按这两个数分档，字段名是它们那边写死的契约。
 */
async function headCounts(env: Env): Promise<{ connections: number; online: number }> {
  const [connections, online] = await Promise.all([
    getRoom(env).connectionCount(),
    getOnlineRoom(env).count(),
  ]);
  return { connections, online };
}

/** 两条 WebSocket 入口共用的握手前检查：来源白名单、必须是升级请求。 */
function rejectSocket(request: Request, env: Env): Response | null {
  if (!isAllowedOrigin(request, env)) {
    return new Response("Forbidden", { status: 403 });
  }
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }
  return null;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 统一 JSON 错误文案。 */
function parseBody(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
}

/** 鉴权与解析在响应前完成；202 表示接收，写入、推送和失效通过 waitUntil 完成。 */
async function handleIngest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  source: string,
): Promise<Response> {
  if (request.method !== "POST") return jsonResponse({ ok: false, error: "只接受 POST" }, { status: 405 });

  const expected = env.TELEMETRY_INGEST_SECRET;
  if (!expected) {
    return jsonResponse({ ok: false, error: "Worker 未配置 TELEMETRY_INGEST_SECRET" }, { status: 503 });
  }
  const provided = bearerToken(request);
  if (!provided || !secretMatches(provided, expected)) {
    return jsonResponse({ ok: false, error: "未授权" }, { status: 401 });
  }
  if (!env.STATE) {
    return jsonResponse({ ok: false, error: "Worker 未配置 STATE" }, { status: 503 });
  }

  const handler = Object.hasOwn(HANDLERS, source) ? HANDLERS[source] : undefined;
  if (!handler) return jsonResponse({ ok: false, error: `没有这个上报来源：${source}` }, { status: 404 });

  let raw: string;
  try {
    raw = await readBoundedBody(request);
  } catch (error) {
    console.error("[ingest] 读取请求体失败", source, reason(error));
    return jsonResponse({ ok: false, error: "无法读取上报数据" }, { status: 400 });
  }

  try {
    const body = parseBody(raw);
    const hub = env.STATE.get(env.STATE.idFromName("global"));
    const result = await hub.ingest(source, body);
    if (!result.ready) return jsonResponse({ ok: false, error: "状态存储初始化中" }, { status: 503 });
    return jsonResponse({ ok: true, data: JSON.parse(result.json) }, { status: 202 });
  } catch (error) {
    console.error("[ingest]", source, reason(error));
    return jsonResponse({ ok: false, error: "上报数据无效或处理失败" }, { status: 400 });
  }
}

/** 限制实际读取字节数，不依赖可能缺失或伪造的 Content-Length。 */
async function readBoundedBody(request: Request): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let result = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > STORAGE_MAX_BYTES) { await reader.cancel(); throw new Error("Body too large"); }
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally { reader.releaseLock(); }
}

async function handleImport(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return jsonResponse({ ok: false }, { status: 405 });
  const expected = env.STATE_IMPORT_SECRET;
  if (!expected || !env.STATE) return jsonResponse({ ok: false }, { status: 503 });
  const provided = bearerToken(request);
  if (!provided || !secretMatches(provided, expected)) return jsonResponse({ ok: false }, { status: 401 });
  try {
    const body = JSON.parse(await readBoundedBody(request));
    const hub = env.STATE.get(env.STATE.idFromName("global"));
    const prefix = env.STORAGE_PREFIX ?? "lyjwpage";
    {
      if (!Array.isArray(body.entries) || body.entries.length > 1000 || !body.entries.every((entry: StoredEntry) =>
        entry && typeof entry.key === "string" && entry.key.startsWith(`${prefix}:`) &&
        (entry.expiresAt === null || Number.isSafeInteger(entry.expiresAt)))) throw new Error("Invalid import");
      const imported = await hub.importMissing(body.entries);
      if (body.finalize === true) await hub.finishImport();
      return jsonResponse({ imported });
    }
  } catch (error) {
    console.error("[storage]", reason(error));
    return jsonResponse({ ok: false, error: "存储请求失败" }, { status: 400 });
  }
}

const CONNECTION_STALE_MS = 5 * 60_000;
const CONNECTION_CLOSE_MS = 30 * 60_000;

/**
 * 全站一个房间。连接走休眠版 `ctx.acceptWebSocket()`，心跳由运行时用
 * `setWebSocketAutoResponse` 直接回，实例可以被回收、连接照样挂着。
 * 所以**不能把连接存在实例字段里**，连接列表一律现问 `ctx.getWebSockets()`；
 * 自动回复也**必须登记在构造函数里**，醒来那一次没有人走接入路径。
 */
export class LivePushRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    // 按 0 / 1 取，不绕 Object.values：WebSocketPair 的类型把这两个下标写成了
    // 具名属性，摊成数组之后 noUncheckedIndexedAccess 会把它们变成可选的
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ at: Date.now() });

    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(message: string): number {
    let delivered = 0;
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
        delivered += 1;
      } catch {
        // 已经断了但还没收到 close 的，丢掉这一条即可，运行时随后会清理
      }
    }
    return delivered;
  }

  /**
   * 数人头时跳过静默超过 5 分钟的连接：对端消失却没发过 close 帧的连接会一直挂在
   * 列表里，一条这样的僵尸就足以把上报器永远钉在中档。判据是运行时替我们记的 ping
   * 自动回复时刻（浏览器每 30 秒发一个），阈值取 5 分钟而不是贴着心跳画线 —— 后台
   * 标签页的定时器会被浏览器节流到最多每分钟一响。
   *
   * 「不计数」和「关掉」是两条线：锁屏、移动端后台会被整个冻结，随时会解冻回来，
   * 关掉只会逼它重连。所以关的那条线推到 30 分钟，顺路在数人头时做掉，不额外挂闹钟。
   */
  connectionCount(now = Date.now()): number {
    let alive = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(socket);
      const attachment = socket.deserializeAttachment() as { at?: unknown } | null;
      const acceptedAt = typeof attachment?.at === "number" ? attachment.at : null;
      // 两样都没有：这次部署之前接进来的旧连接，且此后一个 ping 都没发过
      const lastSeen = pinged?.getTime() ?? acceptedAt;
      const silentMs = lastSeen === null ? Number.POSITIVE_INFINITY : now - lastSeen;
      if (silentMs <= CONNECTION_STALE_MS) {
        alive += 1;
      } else if (silentMs > CONNECTION_CLOSE_MS) {
        // 1001 = going away。关不掉（已经断了）就算了，运行时随后会清理
        try {
          socket.close(1001, "静默过久");
        } catch { }
      }
    }
    return alive;
  }

  async webSocketMessage(): Promise<void> { }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    // 1005（没给关闭码）和 1006（没收到 close 帧）都是"保留码"：
    // 它们描述的是连接怎么断的，不能拿来当自己要发出去的关闭码，传进去会抛
    ws.close(code === 1005 || code === 1006 ? 1000 : code);
  }
}

const worker = {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.STATE || !(await getRoom(env).connectionCount())) return;
    await requestStore.run({ env, ctx }, () => refreshRecentlyPlayed());
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/internal/storage/import") return handleImport(request, env);

    if (url.pathname.startsWith(INGEST_PREFIX)) {
      return handleIngest(request, env, ctx, url.pathname.slice(INGEST_PREFIX.length));
    }

    // 每条返回都带上，不只是成功那条：只有 200 带 CORS 头的话，浏览器侧的调用方
    // 看到的会是一句 CORS 错误，而不是 401 / 400 这些真正说明问题的状态码
    const cors = getCorsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname.startsWith("/api/")) {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: cors });
      const origin = request.headers.get("Origin");
      if (origin && !isAllowedOriginValue(origin, getAllowedOrigins(env))) return jsonResponse({ ok: false }, { status: 403, headers: cors });
      const response = await env.STATE.get(env.STATE.idFromName("global")).fetch(request);
      const headers = new Headers(response.headers);
      cors.forEach((value, name) => headers.set(name, value));
      headers.set("Access-Control-Expose-Headers", "X-Fetched-At");
      return new Response(response.body, { status: response.status, headers });
    }

    if (url.pathname === WS_PATH) {
      const rejected = rejectSocket(request, env);
      if (rejected) return rejected;
      const response = await getRoom(env).fetch(request);
      if (response.status === 101 && env.STATE) {
        await requestStore.run({ env, ctx }, () => refreshRecentlyPlayed());
      }
      return response;
    }

    if (url.pathname === ONLINE_WS_PATH) {
      // 不走上面那条的最近在听刷新：这条连接按可见性反复重连，每切一次标签页就
      // 敲一次 SQLite 闸门不值得；开着页面的那条 /ws 已经把刷新带起来了
      const rejected = rejectSocket(request, env);
      if (rejected) return rejected;
      return getOnlineRoom(env).fetch(request);
    }

    if (url.pathname === "/count") {
      return jsonResponse({ ok: true, ...(await headCounts(env)) }, { headers: cors });
    }

    if (url.pathname === "/") {
      // 只报存活，不碰 Durable Object：根路径被各种探针和浏览器不停打，人头数走 /count
      return jsonResponse({ ok: true, service: "ingest" });
    }

    return new Response("Not found", { status: 404 });
  },
};

export default worker;
