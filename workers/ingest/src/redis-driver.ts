import { ConnectionLeases } from "@/lib/connection-leases";
// 类型从站点那份原文件拿，不走 @/lib/redis-driver：tsconfig 把那个名字映射到本文件自己
import type { RedisAnswer, RedisClient, RedisPipeline } from "../../../src/lib/redis-driver";

import { WorkerRedis } from "./redis-client";
import { requestStore } from "./runtime";

/**
 * `@/lib/redis-driver` 的 Worker 版。wrangler.toml 的 alias 把站点那份（ioredis）换成
 * 这一份，导出面逐个对齐 —— lib/redis 和各 store 一行不改地打进 Worker。
 *
 * 和站点那份的差别只有一处：租约按**请求**分，不按实例分（理由见 runtime.ts 的
 * RequestContext）。连不上就停用 30 秒、期间一律走内存兜底，这一点照抄。
 */

export type { RedisAnswer, RedisClient, RedisPipeline };

const DISABLE_MS = 30_000;

/** 停用窗是全实例的：Redis 挂了不会只对一个请求挂 */
let disabledUntil = 0;
let injected: RedisClient | null | undefined;
/** 请求作用域之外（理论上没有）的兜底租约，让 getRedis 不至于抛 */
const orphanLeases = new ConnectionLeases<RedisClient>();

function leases(): ConnectionLeases<RedisClient> {
  const store = requestStore.getStore();
  if (!store) return orphanLeases;
  return (store.redisLeases ??= new ConnectionLeases<RedisClient>());
}

export function getRedis(): RedisClient | null {
  if (Date.now() < disabledUntil) return null;

  const pool = leases();
  const current = pool.current();
  if (current) return current;

  if (injected !== undefined) {
    if (!injected) return null;
    return pool.use(injected);
  }

  const url = process.env.REDIS_URL;
  if (!url) return null;

  return pool.use(new WorkerRedis(url));
}

export function withRedisScope<T>(run: () => Promise<T>): Promise<T> {
  return leases().scope(run);
}

export function installRedisForTests(client: RedisClient | null): void {
  const current = leases().current();
  if (current) leases().disconnect(current);
  disabledUntil = 0;
  injected = client;
}

export function resetRedisDriverForTests(): void {
  const current = leases().current();
  if (current) leases().disconnect(current);
  injected = undefined;
  disabledUntil = 0;
}

export function key(...parts: string[]) {
  return [process.env.REDIS_PREFIX ?? "lyjwpage", ...parts].join(":");
}

export async function withRedis<T>(
  run: (redis: RedisClient) => Promise<T>,
  fallback: T,
): Promise<T> {
  const pool = leases();
  try {
    return await pool.operation(getRedis, run, fallback);
  } catch (error) {
    console.error("[redis]", error instanceof Error ? error.message : String(error));
    // 出错的这条连接不能留给后面的命令：读写位置已经对不上了
    const current = pool.current();
    if (current) pool.disconnect(current);
    disabledUntil = Date.now() + DISABLE_MS;
    return fallback;
  }
}

const UNREACHABLE = { reachable: false } as const;

export async function askRedis<T>(
  load: (redis: RedisClient) => Promise<T>,
): Promise<RedisAnswer<T>> {
  return withRedis<RedisAnswer<T>>(
    async (redis) => ({ reachable: true, value: await load(redis) }),
    UNREACHABLE,
  );
}

export async function tellRedis(run: (redis: RedisClient) => Promise<unknown>): Promise<boolean> {
  return withRedis(async (redis) => {
    await run(redis);
    return true;
  }, false);
}
