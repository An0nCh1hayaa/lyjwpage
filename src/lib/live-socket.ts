import { workerUrl } from "@/lib/worker-url";

/** 浏览器直连 ingest Worker；站点不发布事件。 */
export function liveSocketUrl(): string | null {
  return workerUrl(process.env.NEXT_PUBLIC_LIVE_PUSH_URL, "/ws", { websocket: true });
}
