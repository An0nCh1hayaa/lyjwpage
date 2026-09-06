import type { NowWatchingPayload, WatchingPayload } from "@/lib/emby";
import { afterResponse, expireStatusTags, publish } from "@/lib/live-platform";
import type {
  ChargerPayload,
  DesktopPayload,
  ListeningPayload,
  NowListeningPayload,
  PlaystationPlayingPayload,
  PlaystationPresencePayload,
  VibeCodingNowPayload,
  PowerBankPayload,
} from "@/lib/types";

/**
 * 服务端 → 浏览器的实时推送。
 *
 * Worker 内的上报直接广播到 Durable Object；Next 内的自拉 / 国内上报通过
 * `/publish` 发给各自的推送房间。Vercel 的写入口在 `workers/ingest`。
 * 本站因此不持有任何常驻连接，也就不要求自己是个常驻进程 —— serverless
 * 部署下这条链路一个字都不用改。地址见 [live-socket](src/lib/live-socket.ts)。
 *
 * 浏览器不需要往回发任何东西，所以是单向广播，Worker 那边一个全站房间就够。
 */

/**
 * 前台应用和播放拆成独立事件。播放来源可能是 MacBook 也可能是 HomePod，
 * 和「Mac 正在使用的应用」无关。
 *
 * 事件名和 /api/status/* 的路径一一对应：**`X` 是列表，`X/now` 是此刻**，
 * 事件这边写成 `X` 和 `X-now`。从前此刻那两条就叫 `listening` / `watching`，
 * 而同名的端点指的是列表，加上列表事件之后两套名字会正好错位。
 */
export type LiveEvent =
  | { type: "desktop"; payload: DesktopPayload }
  | { type: "listening-now"; payload: NowListeningPayload }
  /**
   * 「最近在听」列表变了，带整份数据。
   *
   * 这里曾经只发失效通知、让浏览器自己回来取，理由是「整份十几 KB，浏览器手上
   * 多半只差一两项」—— 两句都不对。实测 4.4 KB；而且发通知之后浏览器照样把整份
   * 取回来，字节一点没省，反倒多出一次请求头、一次往返、一个函数调用和一次
   * Redis 读，**并且是按在线人头乘的**。带数据推是严格更省的。
   *
   * 充电头那条不带历史点是另一回事：那是增量同步，服务端不知道各客户端的游标。
   * 列表是整份替换，没有游标这回事，不适用。
   *
   * 天花板从前是 Pusher 单条事件的 10 KB（4.4 KB 只有两倍余量）。换成自己的
   * Worker 之后是 Cloudflare 的单条 WebSocket 消息上限 1 MiB，这条约束不再逼近。
   */
  | { type: "listening"; payload: ListeningPayload }
  /**
   * 只在插拔、换设备这类结构性变化时发，不跟功率/电压/电流的滚动走 ——
   * 那些量充电时每个上报周期都在变，推它们等于把推送当轮询用。
   * 滚动读数仍由卡片自己的 SWR 轮询负责。
   *
   * 带完整状态但**不带历史点**：推送是广播，服务端不知道每个客户端的曲线
   * 游标，只能要么整份重发（400 个点约 15KB）要么不发。所以按「空增量」发 ——
   * `historyPartial: true` + 空数组，客户端沿用自己已有的曲线，端口和功率
   * 立刻更新。合并逻辑在 lib/charger-history，和轮询那条共用。
   */
  | { type: "charger"; payload: ChargerPayload }
  /** 充电宝：插拔、充放电切换、热控翻转、整数电量跳格时推一条 */
  | { type: "powerbank"; payload: PowerBankPayload }
  /**
   * 此刻在不在写代码变了。只带那三个字段，客户端并进手上已有的整份卡片。
   * 用量、限额、曲线不走这里 —— 那是十几分钟才动一次的累计量，推它们等于
   * 把推送当轮询用。
   */
  | { type: "vibecoding-now"; payload: VibeCodingNowPayload }
  /**
   * 上报器上下线。只发失效通知 —— 亲口离线是布尔值，得把新的
   * declaredOffline 取回来；超时那条浏览器拿手上的 lastSeenAt 自己就能翻。
   *
   * 单独成一种事件，而不是借 desktop / listening 推：前端要能分清「上报器
   * 离线了」和「前台应用变了」，而且需要知道离线的不止那两张卡。
   *
   * 唯一的发出点是 lib/telemetry 的 recordTelemetryEnvelope（存活只在那里翻转），
   * 走 fanout 的 `notify` 那半 —— 它不带数据，浏览器收到就回源，所以必须排在写
   * 后面，理由见下面 fanout 的规则 2。浏览器那侧重取的是 PRESENCE_PATHS 那三份
   * （desktop / listening-now / charger）：时区不看存活；vibe coding 那张刻意不订阅，
   * token 用量是累计的历史事实，Mac 掉线它不会变得不可信，只是不再增长，
   * 那张卡的陈旧判定另有自己的口径。
   */
  | { type: "presence"; payload: null }
  /**
   * Emby 正在播放。webhook 和推送代理驱动，服务端收到时手上就是最新的，
   * 所以直接带数据。
   */
  | { type: "watching-now"; payload: NowWatchingPayload }
  /** 「最近在看」列表变了。和上面那条 listening 同一个形状、同一个理由。实测 2.8 KB */
  | { type: "watching"; payload: WatchingPayload }
  /** PlayStation 此刻在线 / 在玩状态。 */
  | { type: "playing-now"; payload: PlaystationPresencePayload }
  /** PlayStation 最近游玩列表；整份替换，直接写进浏览器 SWR 缓存。 */
  | { type: "playing"; payload: PlaystationPlayingPayload };

/**
 * 状态 tag 常量在 lib/status-tags，这里原样再导出：失效和推送是同一个变化的两条腿，
 * 各 store 从这一个模块拿事件名和 tag 名。
 */
export {
  ACTIVITY_TAG,
  CHARGER_TAG,
  DESKTOP_TAG,
  LISTENING_TAG,
  NOW_LISTENING_TAG,
  NOW_PLAYING_TAG,
  NOW_WATCHING_TAG,
  PLAYING_TAG,
  POWERBANK_TAG,
  SERVER_TAG,
  STATUS_TAGS,
  TIMEZONE_TAG,
  TROPHIES_TAG,
  VIBECODING_TAG,
  VIBECODING_YEAR_TAG,
  WATCHING_TAG,
} from "@/lib/status-tags";

/*
 * 失效、推送、响应之后再跑这三件事依赖运行平台，实现在 lib/live-platform：Next 上是
 * revalidateTag / POST 给 Worker 的 /publish / after()；workers/ingest 打包时把那个模块
 * 换成 Worker 版。这个文件只管「一次上报要扇出什么、按什么顺序」。
 */

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
