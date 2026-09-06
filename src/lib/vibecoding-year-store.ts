import { AwaitingReport } from "@/lib/awaiting-report";
import { mirrorKey } from "@/lib/redis";
import type { StoredVibeCodingYear, VibeCodingYearPayload } from "@/lib/types";
import { normalizeVibeCodingYear, withYearFreshness } from "@/lib/vibecoding-year";

const yearMirror = mirrorKey<StoredVibeCodingYear>(
  ["vibecoding", "year"],
  (state) => state.pushedAt,
);

export function prepareVibeCodingYear(report: unknown, receivedAt = Date.now()) {
  const payload = normalizeVibeCodingYear(report);
  if (!payload) throw new Error("vibeCodingYear 必须是从周日切起的 53 周日合计，并带每天前五的模型表");
  return {
    commit: () => yearMirror.put({ ...payload, pushedAt: receivedAt }),
  };
}

export async function getVibeCodingYear(): Promise<VibeCodingYearPayload> {
  const stored = await yearMirror.get();
  if (!stored) throw new AwaitingReport("尚未收到 Mac Telemetry Hub 的年度用量推送");
  // 「今天是哪一天」不进 Redis，取数出口现盖一次，见 withYearFreshness
  return withYearFreshness(stored);
}
