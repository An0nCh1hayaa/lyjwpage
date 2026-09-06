import { NextResponse } from "next/server";

import { ingestFailed, telemetryAuthorized } from "@/lib/api";
import { expireStatusTags } from "@/lib/live-platform";
import { parseRevalidateRequest } from "@/lib/revalidate-request";

/**
 * Worker 处理完一次上报之后，让这份部署的 `'use cache'` 过期。
 *
 * 写入已经不在这个进程里发生了（落库、推送都在 workers/ingest），但 `revalidateTag`
 * 只能在 Next 进程内调 —— 所以要留这一个口子。它只传 tag 名，不传数据：数据早就
 * 在 Redis 里了，下一次读自己会去拿。请求体的形状和校验见 lib/revalidate-request。
 *
 * 鉴权沿用 TELEMETRY_INGEST_SECRET（Worker 收上报时验的就是它，手上本来就有）。
 * **没配密钥就一律 503，不像 ingest 那样放行**：这一个端点公网可达、专供 Worker，
 * 没有「本地开发不配密钥」的场景。
 */
export async function POST(request: Request) {
  if (!process.env.TELEMETRY_INGEST_SECRET) {
    return ingestFailed("站点未配置 TELEMETRY_INGEST_SECRET", 503);
  }
  if (!telemetryAuthorized(request)) return ingestFailed("未授权", 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return ingestFailed("请求体不是合法 JSON", 400);
  }

  const parsed = parseRevalidateRequest(body);
  if (!parsed.ok) return ingestFailed(parsed.error, 400);

  const { tags, urgentTags } = parsed.value;
  await expireStatusTags(tags, urgentTags);
  return NextResponse.json({ ok: true as const, data: { tags, urgentTags } });
}
