import { sliceChargerHistory, withChargerFreshness } from "@/lib/anker";
import { sinceParam, statusRoute } from "@/lib/api";
import { lastPushReceivedAt } from "@/lib/charger-store";
import { readLiveness, withPresence } from "@/lib/reporter-liveness";
import { chargerStatus } from "@/lib/status-sources";

export function GET(request: Request) {
  const since = sinceParam(request);
  return statusRoute(chargerStatus, async (data) => {
    const [pushedAt, live] = await Promise.all([lastPushReceivedAt(), readLiveness()]);
    return withChargerFreshness(
      withPresence({ ...sliceChargerHistory(data, since), pushedAt }, live),
    );
  });
}
