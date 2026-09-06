import { AsyncLocalStorage } from "node:async_hooks";

import type { ConnectionLeases } from "@/lib/connection-leases";
import type { RedisClient } from "../../../src/lib/redis-driver";

import type { LivePushRoom } from "./index";

export interface Env {
  LIVE_PUSH: DurableObjectNamespace<LivePushRoom>;
  IMAGES: R2Bucket;
  /** 站点 POST /publish 用的密钥。没配则 /publish 一律 503 */
  LIVE_PUSH_SECRET?: string;
  /** 上报器和对端转发用的密钥，也是回敲站点 /api/revalidate 的凭据。没配则上报入口一律 503 */
  TELEMETRY_INGEST_SECRET?: string;
  REDIS_URL?: string;
  /** 要失效缓存的那份站点，如 https://lyjw.me */
  SITE_URL?: string;
  ALLOWED_ORIGINS?: string;
}

export type RequestContext = {
  env: Env;
  ctx: ExecutionContext;
  /**
   * 这一次请求自己的 Redis 租约。
   *
   * 站点那份把租约挂在模块级，同一实例的并发请求共用一条连接；Workers 不允许：
   * 一个请求里建的 socket 不能在另一个请求的处理里读写（"Cannot perform I/O on
   * behalf of a different request"）。所以一次请求一条连接，请求（含 waitUntil 里的
   * 尾巴）结束、命令归零就断，由 redis-driver 懒建。
   */
  redisLeases?: ConnectionLeases<RedisClient>;
};

/**
 * 当前请求的 env 和 ctx。
 *
 * 被 alias 进来的 live-platform / r2-assets / redis-driver 没有参数能接 env —— 它们的
 * 签名是站点那份定的。挂在 AsyncLocalStorage 上而不是模块变量：同一个 isolate 会并发
 * 处理多个请求，模块变量会把 A 的 waitUntil 挂到 B 的 ctx 上。
 */
export const requestStore = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext {
  const store = requestStore.getStore();
  if (!store) throw new Error("不在请求作用域里");
  return store;
}
