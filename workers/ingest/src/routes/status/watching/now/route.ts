import { statusRoute } from "@/lib/api";
import { nowWatchingStatus } from "@/lib/status-sources";

export function GET() {
  return statusRoute(nowWatchingStatus);
}
