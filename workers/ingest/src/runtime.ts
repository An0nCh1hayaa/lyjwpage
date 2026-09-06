import { AsyncLocalStorage } from "node:async_hooks";

import type { ConnectionLeases } from "@/lib/connection-leases";
import type { RedisClient } from "../../../src/lib/redis-driver";

import type { LivePushRoom } from "./index";
import type { OnlineCounterRoom } from "./online-counter";

export interface Env {
  /** 开着的页面（含后台标签页）：事件广播走这个房间 */
  LIVE_PUSH: DurableObjectNamespace<LivePushRoom>;
  /** 此刻可见的页面：页脚「此刻在线」那个数 */
  ONLINE_COUNTER: DurableObjectNamespace<OnlineCounterRoom>;
  IMAGES: R2Bucket;
  /** 上报器使用的密钥，也是回敲站点 /api/revalidate 的凭据。没配则上报入口一律 503 */
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

/** 每次请求或定时任务独立保存绑定、waitUntil 和 Redis 租约，避免并发作用域串用。 */
export const requestStore = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext {
  const store = requestStore.getStore();
  if (!store) throw new Error("不在请求作用域里");
  return store;
}
