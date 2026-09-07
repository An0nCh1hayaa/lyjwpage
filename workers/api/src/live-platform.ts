import type { LiveEvent } from "@/lib/live-events";

import { currentContext, requestStore } from "./runtime";

/** Worker 后台任务、缓存失效通知和房间广播。 */

export function afterResponse(work: () => Promise<void>): Promise<void> {
  const store = requestStore.getStore();
  if (!store) return work();
  store.ctx.waitUntil(work());
  return Promise.resolve();
}

const REVALIDATE_TIMEOUT_MS = 5_000;

/**
 * 一次上报一次 POST，普通和 urgent 一起带过去。失败只记日志：数据已经在 SQLite 里，
 * 缓存最多旧到 cacheLife 兜底的 10 分钟，为此让上报器重发同一份没有意义。
 */
export async function expireStatusTags(
  tags: readonly string[],
): Promise<void> {
  if (!tags.length) return;
  const { env } = currentContext();
  const site = env.SITE_URL?.replace(/\/+$/, "");
  const secret = env.TELEMETRY_INGEST_SECRET;
  if (!site || !secret) {
    console.warn("[revalidate] 没配 SITE_URL / TELEMETRY_INGEST_SECRET，缓存失效停用");
    return;
  }

  try {
    const response = await fetch(`${site}/api/revalidate`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ tags }),
      signal: AbortSignal.timeout(REVALIDATE_TIMEOUT_MS),
    });
    if (!response.ok) {
      // 带上站点给的原因：401 是密钥没对齐、400 是 tag 名单对不上，光看状态码要猜
      const envelope = (await response.json().catch(() => null)) as { error?: string } | null;
      console.error("[revalidate]", site, response.status, envelope?.error ?? "");
    }
  } catch (error) {
    console.error("[revalidate]", error instanceof Error ? error.message : String(error));
  }
}

/** 全站一个房间，和 index.ts 里 /ws 接入的是同一个 */
export const ROOM_ID = "global";

export async function publish(event: LiveEvent): Promise<void> {
  try {
    const { env } = currentContext();
    const room = env.LIVE_PUSH.get(env.LIVE_PUSH.idFromName(ROOM_ID));
    await room.broadcast(JSON.stringify(event));
  } catch (error) {
    console.error("[live]", event.type, error instanceof Error ? error.message : String(error));
  }
}
