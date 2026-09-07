import { key } from "@/lib/storage";
import type { PowerBankStatus } from "@/lib/types";

export const K_LATEST = key("powerbank", "latest");

export const K_LAST_PUSH = key("powerbank", "lastPush");

export const fallback = {
  latest: null as PowerBankStatus | null,
  receivedAt: 0,
  lastPushAt: 0,
  persisted: false,
};

export type Stored = { status: PowerBankStatus; receivedAt: number };
