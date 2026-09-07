import { recordHomePodEvent } from "./homepod-ingest";
import { recordPhoneEnvelope } from "./phone-telemetry";
import { recordEmbyReport } from "./stores/emby";
import { recordPlaystationReport } from "./stores/playstation";
import { recordServerReport } from "./stores/server";
import { recordTelemetryEnvelope } from "./stores/telemetry";
import { recordAgentLimits } from "./stores/vibecoding";

export const HANDLERS: Record<string, (body: unknown) => Promise<unknown>> = {
  mac: recordTelemetryEnvelope,
  iphone: recordPhoneEnvelope,
  homepod: recordHomePodEvent,
  emby: recordEmbyReport,
  playstation: recordPlaystationReport,
  server: recordServerReport,
  agents: recordAgentLimits,
};
