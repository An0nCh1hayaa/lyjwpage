import { statusRoute } from "@/lib/api";
import { listeningStatus } from "@/lib/status-sources";

export async function GET() {
  return statusRoute(listeningStatus);
}
