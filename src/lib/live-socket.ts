import { workerUrl } from "@/lib/worker-url";

/**
 * 浏览器直连 ingest Worker 的两条 WebSocket；站点不发布事件。
 *
 * 只配一个源，路径在这儿拼。`process.env.X` 是构建时按文本替换的，只有写成完整
 * 字面量才替换得到，所以两处各自读、不抽成参数。
 */

/** 事件推送：页面开着就一直挂着，Worker 那侧数它作「开着」的页面。 */
export function liveSocketUrl(): string | null {
  return workerUrl(process.env.NEXT_PUBLIC_LIVE_PUSH_URL, "/ws", { websocket: true });
}

/** 此刻在线：页面不可见时整条关掉，Worker 那侧数它作「可见」的页面。 */
export function onlineSocketUrl(): string | null {
  return workerUrl(process.env.NEXT_PUBLIC_LIVE_PUSH_URL, "/online/ws", { websocket: true });
}
