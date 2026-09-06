import Redis from "ioredis";

import { ConnectionLeases } from "@/lib/connection-leases";

/**
 * Redis 连接的 Node 实现：ioredis + 按请求作用域的租约。
 *
 * 只有这个文件知道 ioredis。上面一层（lib/redis 的 mirrorKey / overlayHashKey）和
 * 各 store 只拿到下面这个 `RedisClient` 子集 —— 它们实际调到的就这几个命令。
 * workers/ingest 把同一批 store 打进 Worker 的包时，用 wrangler 的 alias 把这个模块
 * 换成 cloudflare:sockets 上的实现（workers/ingest/src/redis-driver.ts），导出面一致。
 *
 * 没配 REDIS_URL 就返回 null，各处缓存自动退回进程内存 ——
 * 本地开发不装 Redis 也能跑，线上 Redis 挂掉也只是丢缓存，不会让页面 500。
 */

/** 连不上时先停用一段时间，避免每次请求都卡在重连上 */
const DISABLE_MS = 30_000;

/** 各 store 会调到的 pipeline 命令。链式返回自己，最后 exec。 */
export interface RedisPipeline {
  set(key: string, value: string, ...args: (string | number)[]): RedisPipeline;
  del(key: string): RedisPipeline;
  rpush(key: string, ...values: string[]): RedisPipeline;
  ltrim(key: string, start: number, stop: number): RedisPipeline;
  pexpire(key: string, ms: number): RedisPipeline;
  hset(key: string, object: Record<string, string>): RedisPipeline;
  hgetall(key: string): RedisPipeline;
  get(key: string): RedisPipeline;
  /** ioredis 形状：每条命令一个 `[error, result]`；连接层面失败时整体为 null */
  exec(): Promise<[Error | null, unknown][] | null>;
}

/** 各 store 会调到的命令子集。ioredis 和 Worker 里的 RESP 客户端都满足它。 */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  del(key: string): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  pipeline(): RedisPipeline;
  disconnect(): void;
}

type RedisState = {
  leases: ConnectionLeases<RedisClient>;
  disabledUntil: number;
  /**
   * 测试注入。挂在同一份 `__lyjwRedis` 上，不另起一套。
   * `undefined` 表示没注入；`null` 表示强制不可达；有值则每次从租约里再 use 一次
   * （租约会在 operation 结束后 disconnect）。
   */
  injected?: RedisClient | null;
};

/**
 * 挂 globalThis，保证同一 Node 实例里被不同 Next bundle 引到时仍共用一条连接。
 * 连接本身不永久挂着：最后一个请求 / 命令结束后由租约主动断开。
 */
const state = ((globalThis as typeof globalThis & { __lyjwRedis?: RedisState }).__lyjwRedis ??= {
  leases: new ConnectionLeases<RedisClient>(),
  disabledUntil: 0,
});

function connectionName(): string {
  const environment = process.env.VERCEL_ENV ?? "local";
  const sha = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local";
  const region = process.env.VERCEL_REGION ?? "local";
  return `lyjwpage:${environment}:${sha}:${region}`;
}

export function getRedis(): RedisClient | null {
  if (Date.now() < state.disabledUntil) return null;

  const current = state.leases.current();
  if (current) return current;

  if ("injected" in state) {
    if (!state.injected) return null;
    return state.leases.use(state.injected);
  }

  // 单测进程里绝不自己去连真实 Redis。没注入就是不可达。
  if (process.env.NODE_TEST_CONTEXT) return null;

  const url = process.env.REDIS_URL;
  if (!url) return null;

  const raw = new Redis(url, {
    maxRetriesPerRequest: 1,
    /**
     * 必须让命令排队等连接建立。
     *
     * 关掉的话，进程刚起来、连接还没握手完的那几个请求会立即失败、退回
     * 空的内存兜底 —— 充电头据此误判成「没收到过推送」，走轮询并把 Redis
     * 里存着的推送历史覆盖掉。实测重启后历史确实被真实轮询读数换掉了。
     */
    enableOfflineQueue: true,
    connectTimeout: 2_000,
    // 排队也不能无限等：Redis 真挂了要尽快失败，退回内存而不是拖住请求
    commandTimeout: 2_000,
    connectionName: connectionName(),
  });
  // ioredis 的重载签名对不上上面那个窄接口的 rest 参数，运行时行为是一致的
  const client = state.leases.use(raw as unknown as RedisClient);

  raw.on("error", (error) => {
    if (Date.now() >= state.disabledUntil) console.error("[redis]", error.message);
    state.disabledUntil = Date.now() + DISABLE_MS;
    // 业务停用时必须同时关 socket；否则 ioredis 仍会在后台自动重连、继续占槽。
    state.leases.disconnect(client);
  });

  return client;
}

/**
 * 一次请求或一次缓存重建共用同一条连接；嵌套和 Fluid 同实例并发都安全。
 * 最后一个 scope 与命令结束后立即断开，不靠 serverless 暂停时不会跑的 idle timer。
 */
export function withRedisScope<T>(run: () => Promise<T>): Promise<T> {
  return state.leases.scope(run);
}

/** 只给测试：把假客户端塞进 `__lyjwRedis` 租约。`null` 表示强制不可达。 */
export function installRedisForTests(client: RedisClient | null): void {
  const current = state.leases.current();
  if (current) state.leases.disconnect(current);
  state.disabledUntil = 0;
  state.injected = client;
}

/** 只给测试：清掉注入和停用窗。镜像的内存副本由 lib/redis 的 resetRedisForTests 归零。 */
export function resetRedisDriverForTests(): void {
  const current = state.leases.current();
  if (current) state.leases.disconnect(current);
  delete state.injected;
  state.disabledUntil = 0;
}

/**
 * 统一加前缀，方便和同一个 Redis 里的其它东西区分开。
 *
 * 每次现读 REDIS_PREFIX 而不是模块加载时读一次：Worker 里 process.env 由绑定填充，
 * 模块求值那一刻不保证已经就位。
 */
export function key(...parts: string[]) {
  return [process.env.REDIS_PREFIX ?? "lyjwpage", ...parts].join(":");
}

/** 包一层：Redis 出任何问题都退回 fallback，不往上抛 */
export async function withRedis<T>(
  run: (redis: RedisClient) => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await state.leases.operation(getRedis, run, fallback);
  } catch (error) {
    console.error("[redis]", error instanceof Error ? error.message : String(error));
    return fallback;
  }
}

/** Redis 不可达时的应答。模块级常量，不是每次新建的字面量 */
const UNREACHABLE = { reachable: false } as const;

export type RedisAnswer<T> = { reachable: true; value: T } | typeof UNREACHABLE;

/**
 * 问一次 Redis，把「它说没有」和「它答不上来」分开。
 *
 * `reachable: false` 表示 Redis 不可达 —— 没配 REDIS_URL、连不上、或正落在
 * 出错后那 30 秒停用窗里。包一层才能和「Redis 好好答了，值就是 null」区分：
 * 直接用 `withRedis(get, null)` 的话这两种情况在外面长得一模一样，只能一律
 * 退回进程内存副本，于是清空 Redis 之后数据还从内存里活着。实测踩到过。
 *
 * 为什么用判别字段而不是「返回 null 表示不可达」：Turbopack 会内联分析同一
 * 模块内的调用，只跟到 `return await run(redis)` 这条返回对象字面量的路径，
 * 就断定结果恒为真，把调用方的 `if (!answered)` 整个当成死代码删掉 —— 编译
 * 产物里是 `if ("TURBOPACK compile-time falsy", 0)`。tsc 全绿、跨模块调用也
 * 正常，只有同模块的 mirrorKey 中招，Redis 一断就抛
 * 「Cannot read properties of null」。两条返回路径都给对象就没有这个可乘之机。
 */
export async function askRedis<T>(
  load: (redis: RedisClient) => Promise<T>,
): Promise<RedisAnswer<T>> {
  return withRedis<RedisAnswer<T>>(
    async (redis) => ({ reachable: true, value: await load(redis) }),
    UNREACHABLE,
  );
}

/** 写一次 Redis，返回是否真的落进去了。false 表示这份目前只存在于进程内存 */
export async function tellRedis(run: (redis: RedisClient) => Promise<unknown>): Promise<boolean> {
  return withRedis(async (redis) => {
    await run(redis);
    return true;
  }, false);
}
