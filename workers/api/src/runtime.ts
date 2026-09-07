import { AsyncLocalStorage } from "node:async_hooks";
import type { StorageClient } from "@shared/storage-client";
import type { LivePushRoom } from "./index";
import type { OnlineCounterRoom } from "./online-counter";
import type { StateHub } from "./state-hub";

export interface Env {
  LIVE_PUSH: DurableObjectNamespace<LivePushRoom>;
  ONLINE_COUNTER: DurableObjectNamespace<OnlineCounterRoom>;
  STATE: DurableObjectNamespace<StateHub>;
  IMAGES: R2Bucket;
  TELEMETRY_INGEST_SECRET?: string;
  /** 一次性迁移使用，迁移完成后移除，不授予站点。 */
  STATE_IMPORT_SECRET?: string;
  STORAGE_PREFIX?: string;
  SITE_URL?: string;
  ALLOWED_ORIGINS?: string;
}

export type RequestContext = {
  env: Env;
  ctx: Pick<ExecutionContext, "waitUntil">;
  /** 在状态对象内部直读本地 SQLite；普通 Worker 通过 DO binding 调用。 */
  storage?: StorageClient;
};
export const requestStore = new AsyncLocalStorage<RequestContext>();
export function currentContext(): RequestContext {
  const store = requestStore.getStore();
  if (!store) throw new Error("不在请求作用域里");
  return store;
}
