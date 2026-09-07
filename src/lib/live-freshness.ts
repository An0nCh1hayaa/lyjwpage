import { DESKTOP_PATH, LISTENING_PATH, NOW_LISTENING_PATH, POWERBANK_PATH } from "@/lib/paths";
import type {
  DesktopPayload,
  ListeningPayload,
  NowListeningPayload,
  PowerBankPayload,
  StatusResponse,
} from "@/lib/types";

/**
 * 挡住「回来晚了的旧数据」。
 *
 * 推送和轮询写的是同一个 SWR 键，谁后到谁说了算 —— 但「后到」不等于「更新」。
 * 有两条路会送来过时的数据：
 *
 * 1. **首屏缓存的宽限期。** 上报之后 `revalidateTag(tag, "max")` 让缓存失效，
 *    但那是 stale-while-revalidate：紧接着的一次轮询拿到的是改动**之前**那份，
 *    新的在后台重建。于是刚被推送点亮的卡片会在一两秒后翻回旧值，再等一轮
 *    才翻回来。这条路一直都在，和写库推送谁先谁后无关。
 * 2. **写库和推送同时发车之后**（见 lib/live-events 的 fanout），两者之间多出
 *    一个 SQLite 往返的窗口。窗口里新起的一次轮询会读到写之前的 SQLite。
 *
 * 已经在飞的那次轮询不用管：SWR 自己会丢掉和 mutate 重叠的那次结果
 * （dist/use-swr 里 MUTATION 那段）。它管不到的是**推送之后才起飞**的那次，
 * 这里补的就是那一段。
 *
 * 做法是给每个键记一个单调的时刻，取回来的比记着的旧就把记着的那份原样还回去 ——
 * 还的是同一个对象引用，SWR 深比较后不会重渲染。
 */

/**
 * 每个键从自己的 payload 里取「这是第几代」。
 *
 * 只登记有单调时刻的那几个键，别的不管：
 *
 * - **充电头不进这张表**：功率曲线在客户端增量累加（lib/charger-history），
 *   整份替换会把累加器和缓存拆散。充电宝没有这个问题 —— 它不存历史，推来的
 *   就是整份，直接替换。
 * - **listening/now 用 receivedAt**：它是 Mac 和 HomePod 两个接收时刻取的
 *   最大值（见 pickNowListening），谁胜出都不回落，单调。从前这里写它「是
 *   胜出来源的时刻、换来源会正当地变小」——那是旧语义，早改成双源取大了。
 *   必须挡：切歌推送落地之后，晚回来的一次轮询 / 聚焦重取会把上一首的旧
 *   锚点写回缓存，卡片只是闪一下，跟听却会把它当成「切回上一首」执行一整
 *   套重排加 seek。暂停宽限期到点的重取不受影响：到期只翻结论、不产生新
 *   上报，代数相等，而相等时以取回来的为准（见 freshest）。
 * - **Emby 两份没有时刻可用**，先不管。
 */
const STAMPS: Record<string, (data: never) => number | null> = {
  [DESKTOP_PATH]: (data: DesktopPayload) => data.receivedAt,
  [LISTENING_PATH]: (data: ListeningPayload) => data.fetchedAt,
  [NOW_LISTENING_PATH]: (data: NowListeningPayload) => data.receivedAt,
  [POWERBANK_PATH]: (data: PowerBankPayload) => data.pushedAt,
};

function stampOf(path: string, envelope: StatusResponse<unknown>): number | null {
  if (!envelope.ok) return null;
  return STAMPS[path]?.(envelope.data as never) ?? null;
}

const latest = new Map<string, { stamp: number; envelope: StatusResponse<unknown> }>();

/**
 * 记下推来的这一份。返回它是不是最新的 —— 不是就别写进缓存了，
 * 推送本身也可能乱序到达（两次上报各走各的函数实例，先发的不一定先到）。
 */
export function rememberPushed(path: string, envelope: StatusResponse<unknown>): boolean {
  const stamp = stampOf(path, envelope);
  if (stamp == null) return true;
  const known = latest.get(path);
  if (known && known.stamp > stamp) return false;
  latest.set(path, { stamp, envelope });
  return true;
}

/**
 * 取回来的和记着的比一比，把新的那份交出去。
 *
 * 相等时以取回来的为准：存活（在不在线、亲口离线）会在同一代数据上更新，
 * 挡掉它的话上报器上下线就要等到下一次内容变化才显示得出来。
 */
export function freshest<T>(path: string, envelope: StatusResponse<T>): StatusResponse<T> {
  const stamp = stampOf(path, envelope);
  if (stamp == null) {
    // 降级信封（ok:false）走这条。上游真挂了就该让页面看见，不能拿旧数据盖住
    latest.delete(path);
    return envelope;
  }
  const known = latest.get(path);
  if (known && known.stamp > stamp) return known.envelope as StatusResponse<T>;
  latest.set(path, { stamp, envelope });
  return envelope;
}
