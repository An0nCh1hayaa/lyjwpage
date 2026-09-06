import { workerUrl } from "@/lib/worker-url";

/**
 * 实时推送服务（workers/ingest）的地址。
 *
 * 单独一个模块，是因为两侧要读的是同一份 —— 服务端把事件 POST 到 `/publish`，
 * 浏览器连 `/ws` 收。这个模块零依赖，两侧都能引。
 *
 * 只配一个变量：Worker 的源。两条路径写在下面，拼接规则见 lib/worker-url。
 */

/** 浏览器连的 WebSocket 端点 */
const WS_PATH = "/ws";

/** 服务端发布事件的端点 */
const PUBLISH_PATH = "/publish";

/*
 * 必须写成完整的 `process.env.XXX` 字面量：浏览器那侧没有 process，这一处是
 * 构建时按文本替换掉的，解构或动态取键都替换不到。
 *
 * `NEXT_PUBLIC_` 前缀的变量会被编译进浏览器产物 —— 地址本来就是公开的
 * （谁都能连上收这份公开广播），但 `LIVE_PUSH_SECRET` 绝不能加这个前缀，
 * 加了等于把发布权限公开发布出去。
 */

/** 没配就返回 null，实时推送整体停用（页面退回轮询，本地开发不配也能跑） */
export function liveSocketUrl(): string | null {
  return workerUrl(process.env.NEXT_PUBLIC_LIVE_PUSH_URL, WS_PATH, { websocket: true });
}

/** 同上。服务端还要另外配 `LIVE_PUSH_SECRET` 才发得出去，见 live-events 的 publish */
export function livePublishUrl(): string | null {
  return workerUrl(process.env.NEXT_PUBLIC_LIVE_PUSH_URL, PUBLISH_PATH);
}
