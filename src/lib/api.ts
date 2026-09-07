
import { AwaitingReport } from "@/lib/awaiting-report";
import { withStorageScope } from "@/lib/storage";
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
  return withStorageScope(async () => {
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
      return { ok: false, error: error instanceof AwaitingReport ? message : "状态暂不可用" };
    }
  });
}

function statusJson<T>(envelope: StatusResponse<T>): Response {
  return Response.json(envelope, {
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


export type StatusSource<T> = () => Promise<T>;
export function readStatus<T>(source: StatusSource<T>): Promise<StatusResponse<T>> {
  return statusEnvelope(source);
}
export function statusRoute<T>(source: StatusSource<T>): Promise<Response>;
export function statusRoute<T, U>(source: StatusSource<T>, overlay: (data: T) => Promise<U> | U): Promise<Response>;
export async function statusRoute<T, U>(source: StatusSource<T>, overlay?: (data: T) => Promise<U> | U): Promise<Response> {
  const envelope = await readStatus(source);
  if (!envelope.ok || !overlay) return statusJson(envelope);
  return statusJson(await statusEnvelope(async () => overlay(envelope.data)));
}
