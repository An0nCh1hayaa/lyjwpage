import {
  getHomePodSnapshot
} from "@/lib/homepod-store";
import { pickNowListening, type NowListeningSnapshot } from "@/lib/now-listening";
import { readLiveness, type Liveness } from "@/lib/reporter-liveness";
import type {
  DesktopPayload,
  NowListeningPayload,
  TimezonePayload
} from "@/lib/types";
import { desktopPayload, snapshotFrom, syncTelemetryState, telemetryState } from "@shared/telemetry";

/**
 * 取数路径上先把状态和存活各读一次。
 *
 * 存活是另一个 SQLite key，两者都要，所以一起读 —— 各自 await 一次的话同一个
 * 请求里会多一趟往返。「上报器整体是否已超过心跳窗口」只影响 Mac 来的东西，
 * HomePod 走自己的路径。
 */
async function syncForRead(): Promise<Liveness> {
  const [, liveness] = await Promise.all([syncTelemetryState(), readLiveness()]);
  return liveness;
}

export async function getDesktopPayload(): Promise<DesktopPayload> {
  return desktopPayload(await syncForRead());
}

export async function getTimezonePayload(): Promise<TimezonePayload> {
  await syncTelemetryState();
  return {
    timezone: telemetryState.activeModules.has("timezone") ? telemetryState.timezone : null,
    // 走 cachedTimezone 的 use cache，冻的是填充时刻，最多旧 10 分钟。
    snapshotAt: Date.now(),
  };
}

export async function getNowListeningSnapshot(): Promise<NowListeningSnapshot> {
  await syncTelemetryState();
  return snapshotFrom(await getHomePodSnapshot());
}

export async function getNowListening(): Promise<NowListeningPayload> {
  const [snapshot, liveness] = await Promise.all([
    getNowListeningSnapshot(),
    readLiveness(),
  ]);
  return pickNowListening(snapshot, liveness);
}
