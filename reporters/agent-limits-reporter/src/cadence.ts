import { setTimeout as sleep } from "node:timers/promises";
import { config } from "./config.js";
import { failure, recovered } from "./log.js";

type Cadence = typeof config.cadence;

type HeadCounts = { online: number; connections: number };

const NOBODY: HeadCounts = { online: 0, connections: 0 };

/**
 * ingest Worker 的 `/count` 一次回答两个数：`online` 是此刻可见的页面，
 * `connections` 是开着的页面（含后台标签页）。公开计数口不带 ingest 凭据；
 * 读不到只向慢档退，不影响限额采集和心跳。
 */
async function headCounts(
  url: string,
  timeoutMs: number,
  request: typeof fetch,
): Promise<HeadCounts> {
  if (!url) return NOBODY;
  const scope = "head-count";
  try {
    const response = await request(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`计数接口返回 ${response.status}`);
    const body: unknown = await response.json();
    if (!body || typeof body !== "object") throw new Error("计数接口返回的不是对象");
    const counts = { online: 0, connections: 0 };
    for (const field of ["online", "connections"] as const) {
      const value = (body as Record<string, unknown>)[field];
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`计数接口缺少合法 ${field}`);
      }
      counts[field] = value;
    }
    recovered(scope);
    return counts;
  } catch (error) {
    failure(scope, error);
    return NOBODY;
  }
}

export async function nextDelay(
  cadence: Cadence = config.cadence,
  request: typeof fetch = fetch,
): Promise<number> {
  const counts = await headCounts(cadence.countUrl, cadence.countTimeoutMs, request);
  if (counts.online > 0) return cadence.liveIntervalMs;
  if (counts.connections > 0) return cadence.openIntervalMs;
  return cadence.idleIntervalMs;
}

/** 长档每个快档重查一次，发现更快档立即采集；人数减少不延后已定的心跳。 */
export async function waitForNextRound(
  liveIntervalMs = config.cadence.liveIntervalMs,
  runtime = {
    nextDelay: () => nextDelay(),
    now: () => performance.now(),
    sleep: (ms: number): Promise<void> => sleep(ms),
  },
): Promise<void> {
  const delay = await runtime.nextDelay();
  const deadline = runtime.now() + delay;
  for (;;) {
    const left = deadline - runtime.now();
    if (left <= 0) return;
    await runtime.sleep(Math.min(liveIntervalMs, left));
    if (runtime.now() >= deadline) return;
    if (await runtime.nextDelay() < delay) return;
  }
}
