import { revalidateTag } from "next/cache";
import { after } from "next/server";

import type { NowWatchingPayload, WatchingPayload } from "@/lib/emby";
import { livePublishUrl } from "@/lib/live-socket";
import { statusCacheTag } from "@/lib/status-cache-scope";
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
 * 遥测入口收到上报、状态落库之后，往自己那个 Cloudflare Worker
 * （`workers/live-push`）发一次 HTTP 请求就结束了，长连接全部挂在那边。
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
 * 状态主题，一份一个。缓存标签另加 page / api 前缀，配对见 lib/status-cache。
 * （两个例外：github-chart 那份没有 tag，只靠 cacheLife 兜底；watching-now 只有
 * page 条目，端点两条路都直读 Redis，见 lib/status-cache 的 nowWatchingStatus ——
 * emby 照样推它的 tag，`api:watching-now` 那一半打在空处，无害。）
 *
 * 名字和上面的事件名逐字相同，也就和 /api/status/* 的路径同一套：`X` 是列表、
 * `X-now` 是此刻，URL 里的 `/` 在名字里写成 `-`（AGENTS.md 第 2 条，路径常量在
 * lib/paths）。timezone 没有 status 端点、也没有推送事件，只给首屏用；
 * vibecoding 反过来 —— 有 `vibecoding-now` 这条推送，但没有对应的 `/now` 端点：
 * 此刻那几个字段是并进整张卡里显示的，没人会单独取它们。
 *
 * 摆在这个文件里，是因为失效和推送是同一个变化的两条腿：一条刷缓存给下一个
 * 访客，一条推给当前访客。名字和触发点挨着，改一条时另一条就在眼前。
 */
export const DESKTOP_TAG = "desktop";
export const TIMEZONE_TAG = "timezone";
export const CHARGER_TAG = "charger";
export const POWERBANK_TAG = "powerbank";
export const VIBECODING_TAG = "vibecoding";
/** 年度热力图单独一份缓存：日格子和用量明细不是同一节奏。 */
export const VIBECODING_YEAR_TAG = "vibecoding-year";
export const LISTENING_TAG = "listening";
export const NOW_LISTENING_TAG = "listening-now";
/**
 * 活动圆环。和时区一样只有失效、没有推送事件 —— 圈以分钟为尺度涨，为它开一路
 * 广播就是拿推送当轮询用。卡片按长间隔轮询，命中的是这份被上报刷新过的缓存。
 */
export const ACTIVITY_TAG = "activity";
/**
 * 落地节点快照。和活动圆环一样只有失效、没有推送事件 —— CPU 和网速每个间隔
 * 都在变，为它开一路广播就是拿推送当轮询用。
 *
 * **每次上报都失效**，包括数字几乎没动的那几封：这份快照本身就是心跳，不刷
 * 的话 `'use cache'` 里的 pushedAt 跟着冻住，卡片会把还活着的上报器判成断流。
 * 没变时走普通那半，第一封（空变成有）才 urgent。
 */
export const SERVER_TAG = "server";
export const WATCHING_TAG = "watching";
export const NOW_WATCHING_TAG = "watching-now";
export const PLAYING_TAG = "playing";
/**
 * PlayStation presence。唯一一个**心跳也会失效**的 tag：Worker 每轮 cron 都发一封
 * presence，内容没变那封只刷 observedAt —— 不推这个 tag 的话快照里的时刻跟着冻住，
 * 端点判不出断流（见 lib/playstation 的 assertPresenceFresh）。没变时走普通那半，
 * 只有内容真变了才 urgent。
 */
export const NOW_PLAYING_TAG = "playing-now";
/** 奖杯目录。只有失效，没有推送事件，理由见 paths 的 TROPHIES_PATH。 */
export const TROPHIES_TAG = "trophies";

/**
 * 让首屏缓存里的这几份过期，下一个请求重算。
 *
 * cacheComponents 下 revalidateTag 的第二个参数是必填的 —— 它是「失效之后旧的
 * 还能顶多久」。给 max 拿到的是 stale-while-revalidate：请求立刻拿到旧的那份、
 * 新的在后台重建，上报这条路径上一个字节都不用等。
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
 * 跨部署那半是另一件事，已经解决了：整条上报会被转给对端（lib/ingest-relay），
 * 它自己跑一遍同一个 handler、自己走到这里，失效是那次处理的自然结果，不再需要
 * 单独传播一份缓存状态（从前是 POST 一趟对端的 /api/ingest/revalidate）。
 */
export function expireStatus(...tags: string[]): void {
  for (const tag of tags) {
    revalidateTag(statusCacheTag("page", tag), "max");
    revalidateTag(statusCacheTag("api", tag), "max");
  }
}

/**
 * 立即让 API 缓存失效，首屏仍然先返回旧 HTML、后台更新。
 *
 * 播放、充电结构等变化要求下一次 API 读取拿到新值，因此保留 `{ expire: 0 }`。
 * 首屏使用独立条目和 page 标签：这里若把它也立即过期，7 天 expire 就会被绕过，
 * 无人访问期间的上报会让下一位访客等待整页取数、封面和歌词重建。
 * 页面挂载后由 SWR / 推送更新状态，首屏只做 stale-while-revalidate。
 *
 * 「下一次一定拿到新的」和上面一样只在本实例成立。
 */
export function expireStatusImmediately(...tags: string[]): void {
  for (const tag of tags) {
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
    console.warn("[live] 没配 live-push Worker，实时推送停用，页面只靠轮询更新");
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
 * 把事件交给 live-push Worker，由它广播给所有连着的浏览器。
 *
 * 失败只记一行日志，不往上抛：调用点都在 ingest 路由里，推送丢一条页面靠轮询
 * 也能翻过来。为这个回 500 只会让上报器重试、把同一份数据再写一遍。
 *
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
  /** API 立即失效，首屏仍后台更新，见 expireStatusImmediately */
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
      if (staleTags.length) expireStatus(...staleTags);
      if (urgentTags.length) expireStatusImmediately(...urgentTags);
      // 先失效再通知：浏览器收到就回源，那一趟得读到已经失效的缓存
      if (notify.length) await Promise.all(notify.map(publishPending));
    }
  });
}
