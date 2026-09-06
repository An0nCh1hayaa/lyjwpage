import { AwaitingReport } from "@/lib/awaiting-report";
import { isStale, serverStaleMs } from "@/lib/freshness";
import type { ServerPayload } from "@/lib/types";
import { mirror, type StoredServer } from "@shared/server";

export function withServerFreshness(
  payload: ServerPayload,
  now = Date.now(),
): ServerPayload {
  return {
    ...payload,
    staleAtSource: isStale({
      now,
      at: payload.pushedAt,
      windowMs: payload.staleAfterMs,
    }),
  };
}

function toPayload(stored: StoredServer): ServerPayload {
  return withServerFreshness({
    ...stored.status,
    pushedAt: stored.receivedAt,
    staleAfterMs: serverStaleMs(),
    staleAtSource: false,
  });
}

export async function getServerSnapshot(): Promise<ServerPayload> {
  const stored = await mirror.get();
  if (!stored) throw new AwaitingReport("尚未收到落地节点上报");
  return toPayload(stored);
}
