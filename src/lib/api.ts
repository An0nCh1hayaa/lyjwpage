import { connection, NextResponse } from "next/server";

import { AwaitingReport } from "@/lib/awaiting-report";
import { withRedisScope } from "@/lib/redis";
import type { StatusResponse } from "@/lib/types";

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 读路径的调用方仍从这里拿；类本身在 lib/awaiting-report，理由见那边 */
export { AwaitingReport };

/**
 * 增量拉取的游标。
 *
 * 缺省、或者带了个解析不出有限数的值，都按「要整份」处理 —— 客户端第一次拉
 * 曲线时本来就没有游标，和参数写坏是同一种情况，服务端一视同仁发全量就对了。
 */
export function sinceParam(request: Request): number | undefined {
  const raw = new URL(request.url).searchParams.get("since");
  if (raw == null) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 热力图的游标是 YYYY-MM-DD，充电头的是毫秒时间戳。两种 since 各走各的解析，
 * 写进对方的端点就当没带，退回整份。
 */
export function sinceDateParam(request: Request): string | undefined {
  const raw = new URL(request.url).searchParams.get("since");
  if (raw == null || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  return raw;
}

/**
 * 只要这几个 titleId 对得上的条目，逗号分隔。
 *
 * 和上面几个游标不同，这条要分清**缺席**和**空**：缺席是「要整份」，空是「一款
 * 都不要」。客户端的键是按打开的那块瓷砖拼出来的，拼出空集时它要的就是空 ——
 * 那时退回整份等于把几百 KB 发给一个什么都不显示的面板。
 */
export function titleIdsParam(request: Request): string[] | undefined {
  const raw = new URL(request.url).searchParams.get("titleids");
  if (raw == null) return undefined;
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * 把一个取数函数包成统一的 status 信封。
 * 上游挂了不往上抛 —— 前端拿到 ok:false 后渲染降级态即可，
 * 不让一个离线的充电头把整页 SWR 变成错误状态。
 *
 * 路由和首屏服务端渲染共用这一份：两处的降级形状必须一模一样，
 * 否则同一张卡在首屏和轮询之后会走不同的分支。
 */
export async function statusEnvelope<T>(
  loader: () => Promise<T>,
): Promise<StatusResponse<T>> {
  return withRedisScope(async () => {
    try {
      return { ok: true, data: await loader() };
    } catch (error) {
      const message = reason(error);
      if (error instanceof AwaitingReport) {
        // 还没有数据而已，一行说清楚就行，不占浮层也不带栈
        console.warn("[status]", message);
      } else {
        // 带上栈：降级信封只把 message 发给页面，没有栈的话服务端日志里
        // 一句「Cannot read properties of null」根本定位不到是哪一处
        console.error("[status]", error instanceof Error ? (error.stack ?? message) : message);
      }
      return { ok: false, error: message };
    }
  });
}

function statusJson<T>(envelope: StatusResponse<T>): NextResponse<StatusResponse<T>> {
  return NextResponse.json(envelope, {
    status: 200,
    /**
     * 时间戳放响应头，不进 body：进了 body 就等于每次响应都不一样，
     * 前端再想判断「数据变没变」永远为假 —— 见 StatusResponse 的注释。
     */
    headers: {
      "Cache-Control": "no-store",
      "X-Fetched-At": new Date().toISOString(),
    },
  });
}

/**
 * 状态端点用不用 `'use cache'`，按部署填，默认用。
 *
 * 填 `false` 的那份上，`app/api/status/` 下的状态 GET 一律每次直读 Redis，缓存那层
 * 整个不进（没有例外，加新端点时不用另行登记）。给国内那份准备的：
 * `revalidateTag` 只失效**本实例**那份缓存（Next 默认是每个进程各自的内存
 * LRU，Vercel 另接了一套共享存储，所以在那边看起来是全局的），EdgeOne 跑的是原样的
 * Next（腾讯云 SCF，多实例），于是收到上报的实例失效了自己那份，服务 GET 的实例
 * 不知情，只能等 cacheLife 的 10 分钟兜底 —— 2026-08-16 两边并排量过（当时
 * revalidate 还是 60 秒），EdgeOne 落后 12~45 秒。而那份部署的 Redis 就在同一朵
 * 云上，多打几次不心疼。
 *
 * **只管状态端点。** 首屏那份得冻着才能预渲染（见 next.config.ts 和
 * lib/status-cache），所以关掉之后第一帧仍可能旧到 10 分钟，挂载后 SWR 打这些端点
 * 就是最新的。光配共享的 cacheHandlers 对不齐首屏：EdgeOne 的边缘还按 Next 发的
 * ISR 头另存一份 HTML，见 lib/live-events 的 expireStatus。
 */
const STATUS_CACHE = process.env.STATUS_CACHE !== "false";

/**
 * 一份状态数据的两种取法。
 *
 * 两条路必须是同一份数据的两种视图 —— 开关一翻，端点发出去的形状不能跟着变，
 * 否则同一张卡在两份部署上会走不同分支。配对写在 lib/status-cache 里，那边本来
 * 就同时拿着 tag 和 loader。
 */
export type StatusSource<T> = {
  /** API 专用缓存，和首屏的条目及失效标签分开 */
  cached: () => Promise<StatusResponse<T>>;
  /** 关掉缓存时直读 */
  live: () => Promise<T>;
};

/** 配一对。走这个壳子而不是写对象字面量，是为了让两半的数据类型对不上时当场报错 */
export function statusSource<T>(
  cached: () => Promise<StatusResponse<T>>,
  live: () => Promise<T>,
): StatusSource<T> {
  return { cached, live };
}

/**
 * 一条状态 GET 的响应。
 *
 * cacheComponents 下没有 force-dynamic 可写了，「每次请求都得跑一遍」只能由
 * connection() 明说。少了它 Next 会试着在构建期把这些 GET 预渲染成静态响应，
 * 而 statusEnvelope 的 try/catch 会把预渲染的中断信号一并吞掉（内置文档专门警告
 * 过这一点），构建期那份 ok:false 就被烤进静态响应，客户端从此永远轮询到同一个
 * 错误。
 *
 * overlay 在取数之外跑：给存活这种心跳更新、以及跟着墙上的钟走的判定（暂停宽限、
 * HomePod 静默、PlayStation presence 断流）现盖一层。取数降级了就把降级信封原样
 * 发出去，不盖。
 *
 * overlay 自己抛出来的也走同一个信封，不往上抛：现算这一层同样可能得出「这份
 * 现在不作数」的结论（断流就是），而那和上游挂了是同一类事，不该变成 500 把
 * 整页 SWR 打成错误态。抛 AwaitingReport 就只记一行，理由见那个类。
 */
async function statusResponse<T, U>(
  load: () => Promise<StatusResponse<T>>,
  overlay?: (data: T) => Promise<U> | U,
): Promise<NextResponse<StatusResponse<T | U>>> {
  await connection();
  return withRedisScope(async () => {
    const envelope = await load();
    if (!envelope.ok || !overlay) return statusJson(envelope);
    return statusJson(await statusEnvelope(async () => overlay(envelope.data)));
  });
}

/**
 * 按 STATUS_CACHE 取一份状态：开着读冻起来的那份，关着直读。
 *
 * 状态 GET 之外要读同一份数据的地方也走这里（歌词端点拿它做白名单），别直接
 * 调 `source.cached` —— 那等于在国内那份部署上绕过开关，读到的是最多旧 10 分钟
 * 的快照，而它旁边的 `/api/status/listening/now` 已经在直读 Redis 了。
 */
export function readStatus<T>(source: StatusSource<T>): Promise<StatusResponse<T>> {
  return STATUS_CACHE ? source.cached() : statusEnvelope(source.live);
}

/**
 * `app/api/status/` 下每一条状态 GET 都走这里。取哪一路由 STATUS_CACHE 决定，路由
 * 本身不知道自己冻没冻 —— 知道了就等于每条路由各写一遍开关，漏一条就是那条端点
 * 在国内那份上一直冻着。
 */
export function statusRoute<T>(
  source: StatusSource<T>,
): Promise<NextResponse<StatusResponse<T>>>;
export function statusRoute<T, U>(
  source: StatusSource<T>,
  overlay: (data: T) => Promise<U> | U,
): Promise<NextResponse<StatusResponse<U>>>;
export function statusRoute<T, U>(
  source: StatusSource<T>,
  overlay?: (data: T) => Promise<U> | U,
): Promise<NextResponse<StatusResponse<T | U>>> {
  return statusResponse(() => readStatus(source), overlay);
}
