import type { LiveEvent } from "@/lib/live-events";

import { currentContext, requestStore } from "./runtime";

/**
 * `@/lib/live-platform` 的 Worker 版，三个导出名和站点那份一致（见那边的说明）。
 *
 * - afterResponse：ctx.waitUntil。响应先回给上报器，落库、推送、失效在后面跑完。
 * - expireStatusTags：POST 站点的 /api/revalidate。`revalidateTag` 只能在 Next 进程里
 *   调，这是整条写路径上唯一一次回到站点。
 * - publish：直接进 Durable Object 广播，不再绕一次 HTTP 的 /publish。
 */

export function afterResponse(work: () => Promise<void>): Promise<void> {
  const store = requestStore.getStore();
  if (!store) return work();
  store.ctx.waitUntil(work());
  return Promise.resolve();
}

const REVALIDATE_TIMEOUT_MS = 5_000;

/**
 * 一次上报一次 POST，普通和 urgent 一起带过去。失败只记日志：数据已经在 Redis 里，
 * 缓存最多旧到 cacheLife 兜底的 10 分钟，为此让上报器重发同一份没有意义。
 */
export async function expireStatusTags(
  tags: readonly string[],
  urgentTags: readonly string[],
): Promise<void> {
  if (!tags.length && !urgentTags.length) return;
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
      body: JSON.stringify({ tags, urgentTags }),
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
