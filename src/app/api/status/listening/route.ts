import { statusRoute } from "@/lib/api";
import { listeningStatus } from "@/lib/status-cache";

export async function GET() {
  return statusRoute(listeningStatus);
}
