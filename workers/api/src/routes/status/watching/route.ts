import { statusRoute } from "@/lib/api";
import { watchingStatus } from "@/lib/status-sources";

export function GET() {
  return statusRoute(watchingStatus);
}
