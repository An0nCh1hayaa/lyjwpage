import type { NowWatchingPayload, WatchingPayload } from "@/lib/emby";
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

/** Worker → 浏览器的事件契约。发布实现仅在 workers/ingest/src/fanout.ts。 */

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
   * 唯一的发出点是 workers/ingest/src/stores/telemetry 的 recordTelemetryEnvelope（存活只在那里翻转），
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
