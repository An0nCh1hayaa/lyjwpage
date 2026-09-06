import { revalidateTag } from "next/cache";
import { after } from "next/server";

import type { LiveEvent } from "@/lib/live-events";
import { livePublishUrl } from "@/lib/live-socket";
import { statusCacheTag } from "@/lib/status-cache-scope";

/**
 * 扇出里三件依赖运行平台的事：响应之后再跑、失效缓存、推给浏览器。Next 版。
 *
 * lib/live-events 的 fanout 只认这三个函数名，不认它们背后是谁。workers/ingest 把
 * 同一批 store 打进 Worker 时用 wrangler 的 alias 换成 workers/ingest/src/live-platform.ts：
 * 那边 after 是 ctx.waitUntil、失效是 POST 站点的 /api/revalidate、推送直接进
 * Durable Object。三个导出名两边必须一致。
 */

/**
 * 把一段活挪到响应之后。
 *
 * 上报器要的是「收下了」这三个字，不是「全都落地了」—— 那也正是 202 的意思。
 * 但**裸 fire-and-forget 在 serverless 上不是「不管结果」，是「根本没执行」**：
 * 响应一返回实例就可能被冻住，没跑完的写和推送直接被掐，一行日志都留不下。
 *
 * `after()` 是这两者之间的那一档：响应先发出去，实例保持活着把它做完（Vercel 上
 * 落到 Fluid 的 waitUntil）。所以这不是一笔省钱的改动 —— waitUntil 期间实例照样
 * 计费，换的是上报器那侧不再为落库、推送、跨海转发的耗时买单。
 *
 * Redis 连接不用特意保着：租约要 scope 和在飞的命令**都**归零才断开
 * （见 lib/connection-leases 的 closeIfIdle），响应返回时命令还在飞，连接就还在。
 *
 * 平台没有 waitUntil、或者压根不在请求作用域里时，`after()` 会**同步抛**。那就
 * 退回原来的行为、在响应里等完 —— 所以调用方仍然要 await 这个返回值。慢，但比
 * 静默丢掉强：丢掉的表现是那份数据一直缺着，要很久才会有人发现。
 */
export function afterResponse(work: () => Promise<void>): Promise<void> {
  try {
    after(work);
    return Promise.resolve();
  } catch {
    return work();
  }
}

/**
 * 让首屏与状态 API 的缓存过期。普通 tag 两份都后台更新；urgent tag 让 API 那份
 * 立即失效，首屏仍先返回旧 HTML、后台更新。
 *
 * cacheComponents 下 revalidateTag 的第二个参数是必填的 —— 它是「失效之后旧的
 * 还能顶多久」。给 max 拿到的是 stale-while-revalidate：请求立刻拿到旧的那份、
 * 新的在后台重建，上报这条路径上一个字节都不用等。
 *
 * 播放、充电结构等变化要求下一次 API 读取拿到新值，因此 urgent 给 `{ expire: 0 }`。
 * 首屏使用独立条目和 page 标签：这里若把它也立即过期，7 天 expire 就会被绕过，
 * 无人访问期间的上报会让下一位访客等待整页取数、封面和歌词重建。
 * 页面挂载后由 SWR / 推送更新状态，首屏只做 stale-while-revalidate。
 *
 * **只刷本实例。** 不配 `cacheHandlers` 时 `'use cache'` 存在每个进程各自的内存
 * LRU 里，失效事件不跨实例（内置文档 how-revalidation-works）。Vercel 另外接了一套
 * 共享的缓存和 tag 存储，所以在那边看起来是全局的；EdgeOne 跑的是原样的 Next
 * （腾讯云 SCF，多实例），收到上报的那个实例只失效自己那份，别的实例要等 cacheLife
 * 的 10 分钟兜底 —— 那份部署因此把 STATUS_CACHE 关掉，状态端点一律直读 Redis，
 * 见 lib/api。
 *
 * **首屏在 EdgeOne 上还多一层边缘缓存，共享 cacheHandlers 也够不着。** Next 给
 * 预渲染页发的是按 STATUS_LIFE 算出的 ISR 头，2026-09-06 从 lyjw131.com 实测：
 * `Cache-Control: s-maxage=600, stale-while-revalidate=604200, durable`。Vercel 会把
 * 它改写成 `max-age=0, must-revalidate`、用自己的缓存管新鲜度，EdgeOne 则原样在边缘
 * 存 10 分钟。所以就算各配一个 Redis 存 tag 时间戳把实例对齐了，边缘那份 HTML 也要
 * 等 s-maxage 到期；真要对齐得在上报扇出里再清一次 EdgeOne 的缓存。revalidate 又
 * 不能短于 5 分钟（短了就退出预渲染，见 lib/status-cache 的 STATUS_LIFE），当前
 * 取舍是接受这 10 分钟：同日两个域名并排量，首屏都只旧 2~3 分钟，挂载后 SWR 纠正。
 *
 * 这里是同步的 revalidateTag，包成 async 只为了和 Worker 那版（一次 HTTP）同一个签名。
 */
export async function expireStatusTags(
  tags: readonly string[],
  urgentTags: readonly string[],
): Promise<void> {
  for (const tag of tags) {
    revalidateTag(statusCacheTag("page", tag), "max");
    revalidateTag(statusCacheTag("api", tag), "max");
  }
  for (const tag of urgentTags) {
    revalidateTag(statusCacheTag("page", tag), "max");
    revalidateTag(statusCacheTag("api", tag), { expire: 0 });
  }
}

type PushTarget = { url: string; secret: string };

let target: PushTarget | null = null;
let resolved = false;

/** 没配全就一直是 null，只在第一次抱怨一句，不是每条事件都刷屏 */
function pushTarget(): PushTarget | null {
  if (resolved) return target;
  resolved = true;

  const url = livePublishUrl();
  const secret = process.env.LIVE_PUSH_SECRET;
  if (!url || !secret) {
    console.warn("[live] 没配实时推送 Worker，推送停用，页面只靠轮询更新");
    return null;
  }

  target = { url, secret };
  return target;
}

/**
 * 单条推送最多等多久。
 *
 * 必须自己设：SDK 时代那个超时是 pusher 包自带的，换成裸 fetch 之后没人管，
 * Worker 一挂就会把每一次上报都吊在这里 —— 而上报是有真实数据在等着落库的。
 * 推送本来就是尽力而为，宁可丢一条让轮询兜底。
 */
const PUBLISH_TIMEOUT_MS = 3_000;

/**
 * 把事件 POST 给 Worker 的 /publish，由它广播给所有连着的浏览器。
 *
 * 站点这侧还在用它的只剩「最近在听」那份自拉的列表（lib/apple-music-recent）——
 * 那一路没有上报方，只能由站点自己写；其余写入都已经在 Worker 里，那边直接进房间。
 *
 * 失败只记一行日志，不往上抛：推送丢一条页面靠轮询也能翻过来。
 * 调用点一律 `await`：serverless 上响应一发出，没等完的后台工作随时可能被
 * 掐掉，fire-and-forget 会变成「偶尔推不出去」。
 */
export async function publish(event: LiveEvent): Promise<void> {
  const push = pushTarget();
  if (!push) return;

  try {
    const response = await fetch(push.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${push.secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error("[live] publish", event.type, response.status);
    }
  } catch (error) {
    console.error("[live]", error instanceof Error ? error.message : String(error));
  }
}
