import type { LiveEvent } from "@/lib/live-events";
import { afterResponse, expireStatusTags, publish } from "./live-platform";

/**
 * 一份还要现算的推送。算它可能要读另一个 store、查一次 Apple 目录，
 * 那些和写库互不相干，所以整个交给 fanout 去和写库并行。
 */
export type PendingEvent = LiveEvent | null | Promise<LiveEvent | null>;

export type Fanout = {
  /** 落库。**已经发车了的** promise —— fanout 只负责等，不负责启动 */
  writes?: ReadonlyArray<Promise<unknown>>;
  /** 带数据的推送 */
  events?: ReadonlyArray<PendingEvent>;
  /**
   * 不带数据、只让浏览器回来重取的推送（presence）。
   *
   * 和 `events` 分开是因为它守的是相反的那条规则：浏览器收到它会回源，所以它
   * 必须排在写**后面**，不能和写并行。放进 `events` 等于把那次回源丢回和写库的
   * 竞态里。见下面 fanout 的规则 2。
   */
  notify?: ReadonlyArray<PendingEvent>;
  /** 首屏与 API 均后台更新 */
  tags?: readonly string[];
  /** API 立即失效，首屏仍后台更新，见 lib/live-platform 的 expireStatusTags */
  urgentTags?: readonly string[];
};

/**
 * 发一条待定的推送，拼不出来或推不出去都只记一行日志。
 *
 * 拼不出推送的那份不该把一次成功的上报变成 400 —— 数据照样落库了，页面靠轮询
 * 也能翻过来。和 publish 自己吞错误是同一个理由。`notify` 那半还多一条：它跑在
 * `finally` 里，抛出去就是 after() 回调的一个 unhandled rejection。
 */
async function publishPending(pending: PendingEvent): Promise<void> {
  try {
    const event = await pending;
    if (event) await publish(event);
  } catch (error) {
    console.error("[live]", error instanceof Error ? error.message : String(error));
  }
}

/**
 * 一次上报的扇出：落库、推送、失效。
 *
 * 先后不是随便排的，两条规则：
 *
 * 1. **写库和带数据的推送同时做。** 推来的整份数据浏览器直接写进 SWR 缓存
 *    （`revalidate: false`，见 hooks/use-live-events），不会回头问服务端，
 *    所以它压根不关心那一刻 Redis 写完没有。串着做的话，Vercel 到 Redis 的那
 *    一个来回是白等的 —— 而这条链路上本来就已经压着好几个来回了。
 *
 *    前提是**推送的那份不能是从 Redis 读回来的**：读回来的话它当然得排在写
 *    之后。所以各处都改成拿手上现成的数据现拼，见各 store 的 prepare*。
 *
 * 2. **失效必须等写完。** revalidateTag 会让下一次请求回源重算，早于写库触发
 *    的话，重算读到的是改动之前的 Redis，然后把那个旧值连同一个崭新的有效期
 *    一起缓存起来 —— 比不失效还糟。不带数据、只让浏览器重取的事件（presence）
 *    同理，它触发的也是一次回源，所以它走 `notify` 那半、和失效一起排在写后面。
 *
 * **整块都在响应之后跑**（见 afterResponse）。上报器等的只是本地把这份报文算完，
 * 落库、推送、失效都不在它的等待里 —— 但规则 2 的顺序在这块**内部**仍然成立，
 * 别因为「都不等了」就把失效也一起甩出去和写并行。从前 presence 那条是在调用方
 * `await fanout(...)` 之后发的，`after()` 一上来它就成了「响应发完就跑」，反倒
 * 排在了还在飞的写前面 —— 这正是规则 2 要防的事，所以它只能收进这个 finally。
 */
export function fanout({
  writes = [],
  events = [],
  notify = [],
  tags = [],
  urgentTags = [],
}: Fanout): Promise<void> {
  /**
   * 同一个 tag 两边都进时，urgent 赢。
   *
   * 一封信封里两份数据都变、而它们共用一个 tag 时会撞上（PlayStation 的
   * playedGames 和 trophies 就是），从前正确性靠下面两行 revalidateTag 的先后
   * 顺序 —— 而「后调用的那次说了算」是 Next 的实现细节，不是它承诺的事。
   * 普通那半只是给旧值一个宽限期，urgent 说的是「下一次必须是新的」，
   * 弱的那条不能把强的盖回去。
   */
  const staleTags = tags.filter((tag) => !urgentTags.includes(tag));
  return afterResponse(async () => {
    try {
      await Promise.all([...writes, ...events.map(publishPending)]);
    } catch (error) {
      /**
       * 从前这里靠 `finally` 往下走、错误交给调用方的 await 抛给 400。现在响应
       * 早发出去了，没人接得住 —— 不吞掉就是一个 unhandled rejection。
       */
      console.error("[ingest] 落库", error instanceof Error ? error.message : String(error));
    } finally {
      // 写抛出来了也照样失效、照样通知：已经落库的那几份不该继续被旧缓存遮着，
      // 存活翻转本身也是这封信封确实带来的变化
      // 失效要 await 完：Worker 里它是一次到站点的 HTTP，不等完下面的通知就抢在前面了
      if (staleTags.length || urgentTags.length) await expireStatusTags(staleTags, urgentTags);
      // 先失效再通知：浏览器收到就回源，那一趟得读到已经失效的缓存
      if (notify.length) await Promise.all(notify.map(publishPending));
    }
  });
}
