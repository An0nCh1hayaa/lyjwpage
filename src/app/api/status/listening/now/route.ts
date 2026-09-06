import { statusRoute } from "@/lib/api";
import { pickNowListening } from "@/lib/now-listening";
import { readLiveness } from "@/lib/reporter-liveness";
import { nowListeningStatus } from "@/lib/status-cache";

export async function GET() {
  return statusRoute(nowListeningStatus, async (snapshot) =>
    pickNowListening(snapshot, await readLiveness()),
  );
}
