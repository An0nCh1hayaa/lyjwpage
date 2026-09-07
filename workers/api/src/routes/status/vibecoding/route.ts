import { statusRoute } from "@/lib/api";
import { readLiveness, withPresence } from "@/lib/reporter-liveness";
import { vibeCodingStatus } from "@/lib/status-sources";

export function GET() {
  return statusRoute(vibeCodingStatus, async (data) =>
    withPresence(data, await readLiveness()),
  );
}
