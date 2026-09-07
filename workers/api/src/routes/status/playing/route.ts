import { statusRoute } from "@/lib/api";
import { playingStatus } from "@/lib/status-sources";

export function GET() {
  return statusRoute(playingStatus);
}
