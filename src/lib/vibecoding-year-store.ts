import { AwaitingReport } from "@/lib/awaiting-report";
import type { VibeCodingYearPayload } from "@/lib/types";
import { withYearFreshness } from "@/lib/vibecoding-year";
import { yearMirror } from "@shared/vibecoding-year-store";

export async function getVibeCodingYear(): Promise<VibeCodingYearPayload> {
  const stored = await yearMirror.get();
  if (!stored) throw new AwaitingReport("尚未收到 Mac Telemetry Hub 的年度用量推送");
  // 「今天是哪一天」不进 SQLite，取数出口现盖一次，见 withYearFreshness
  return withYearFreshness(stored);
}
