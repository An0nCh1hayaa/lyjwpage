import { ingestRoute } from "@/lib/api";
import { recordHomePodEvent } from "@/lib/homepod-ingest";

/** Home Assistant pushes HomePod track and playback-state changes here. */
export async function POST(request: Request) {
  return ingestRoute(request, recordHomePodEvent);
}
