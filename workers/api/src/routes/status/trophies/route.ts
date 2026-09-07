import { statusRoute, titleIdsParam } from "@/lib/api";
import { trophiesStatus } from "@/lib/status-sources";
import { sliceTrophies } from "@/lib/trophies";

export function GET(request: Request) {
  const titleIds = titleIdsParam(request);
  return statusRoute(trophiesStatus, (data) =>
    titleIds == null ? data : sliceTrophies(data, titleIds),
  );
}
