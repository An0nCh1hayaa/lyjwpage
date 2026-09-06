import { AwaitingReport } from "@/lib/awaiting-report";
import {
  clearNowPlaying,
  getCurrentItem,
  getImageObjectKeys,
  getNowPlaying,
  getResume,
  resolveNowPlaying,
  setCurrentItem,
  setImageObjectKeys,
  setNowPlaying,
  setResume,
  type EmbyNowPlaying,
  type ResolvedNowPlaying,
  type StoredWatchingItem,
} from "@/lib/emby-store";
import { hasStoredImage, IMAGE_OBJECT_KEY, publicAssetUrl } from "@/lib/r2-assets";
import { number, object, text } from "@/lib/json";
import {
  fanout,
  NOW_WATCHING_TAG,
  WATCHING_TAG,
  type PendingEvent,
} from "@/lib/live-events";
import type { WatchingItem } from "@/lib/types";

/**
 * Emby「最近在看」。
 *
 * 本站不发任何 Emby 请求 —— 站点将来跑在 Vercel 上，内网里的 Emby 那时根本
 * 够不着。续播列表、播放位置、海报全部由 NAS 上的推送代理送进来
 * （reporters/emby-reporter → api/ingest/emby）。Emby 自己的播放
 * webhook 也先发给那个代理，再由它带着密钥转发过来 —— Emby 的 webhook 配置项
 * 加不了自定义请求头，直发站点就只能开一个不鉴权的入口。
 *
 * 于是这个文件只剩两件事：把推来的东西规范化存下，以及读出来拼成前端要的形状。
 */

/** 图片键由代理拼（itemId:kind:tag:height），这里只挡住不像键的东西 */
const IMAGE_KEY = /^[A-Za-z0-9:_.-]{1,160}$/;
/**
 * 「最近在看」和「正在播放」拆成两份，因为它们的刷新节奏根本不同：
 * 前者一天可能只变几次，后者跟着播放走。
 * 合成一个端点的话，慢的那半会被快的那半的节奏拖着白跑。
 */
export type WatchingPayload = {
  items: WatchingItem[];
};

export type NowWatchingPayload = {
  /** 此刻播放中的那一条，附带设备与暂停状态 */
  nowPlaying: ResolvedNowPlaying | null;
  /**
   * 播放中那一项的详情。
   *
   * 单独给是因为它不一定在 Resume 列表里（刚开播、或已经看完就会掉出去），
   * 而两个端点各自刷新，服务端没法再像从前那样把它插进列表里返回。
   * 置顶和去重交给页面做 —— 那本来就是展示逻辑。
   */
  current: WatchingItem | null;
};

/** 把存下来的条目里的图片键换成当前部署的公开地址。键还没对应上图就先空着 */
function resolve(item: StoredWatchingItem, objectKeys: Record<string, string>): WatchingItem {
  const { posterKey, backdropKey, ...rest } = item;
  const posterObjectKey = posterKey ? objectKeys[posterKey] : null;
  const backdropObjectKey = backdropKey ? objectKeys[backdropKey] : null;
  return {
    ...rest,
    poster: posterObjectKey ? publicAssetUrl(posterObjectKey) : null,
    backdrop: backdropObjectKey ? publicAssetUrl(backdropObjectKey) : null,
  };
}

/**
 * 拼装和取数分开：上报那条路上这些东西全在手上（刚规范化好的列表、刚落下的
 * 播放状态），不必等它们写进 Redis 再读回来。条数的默认值只在这里写一遍。
 */
export function watchingPayload(
  items: StoredWatchingItem[],
  objectKeys: Record<string, string>,
  { limit = 8 } = {},
): WatchingPayload {
  return { items: items.slice(0, limit).map((item) => resolve(item, objectKeys)) };
}

export function nowWatchingPayload(
  live: ResolvedNowPlaying | null,
  current: StoredWatchingItem | null,
  objectKeys: Record<string, string>,
): NowWatchingPayload {
  if (!live) return { nowPlaying: null, current: null };
  // 详情比 webhook 晚到一拍很正常（代理下一轮才把这一项推来），对不上就先不给
  return {
    nowPlaying: live,
    current: current?.id === live.itemId ? resolve(current, objectKeys) : null,
  };
}

export async function getWatching(options: { limit?: number } = {}): Promise<WatchingPayload> {
  const stored = await getResume();
  // 还没收到过推送。交给 statusRoute 变成降级信封，前端显示提示
  if (!stored) throw new AwaitingReport("尚未收到 Emby 推送");

  return watchingPayload(stored.items, await getImageObjectKeys(), options);
}

/** 全靠推送，空闲时零上游请求 —— 没在播就只读一次自家存储 */
export async function getNowWatching(): Promise<NowWatchingPayload> {
  const live = await getNowPlaying();
  if (!live) return { nowPlaying: null, current: null };

  return nowWatchingPayload(
    live,
    (await getCurrentItem())?.item ?? null,
    await getImageObjectKeys(),
  );
}

/* ── 以下是推送代理那一侧的入口 ──────────────────────────────── */

/**
 * 代理推来的一项。
 *
 * 只带 Emby 说了什么，不带怎么显示：标题拼法和「在 Emby 里打开」的链接都在
 * 这一侧做 —— 前者是展示逻辑，后者要用 EMBY_PUBLIC_URL，那是浏览器侧的地址，
 * 代理不该知道。
 */
type ReportItem = {
  id: string;
  name: string;
  type: string | null;
  serverId: string | null;
  seriesName: string | null;
  season: number | null;
  episode: number | null;
  year: number | null;
  progress: number;
  playedAt: string | null;
  posterKey: string | null;
  backdropKey: string | null;
};

/**
 * 三个会撞上 Object.prototype 的名字。
 *
 * 映射是个普通对象，`objectKeys["__proto__"] = "…"` 那一下被 setter 吃掉、什么也
 * 没存（值是字符串，构不成原型污染），但**读**的那一下拿回来的是 Object.prototype
 * 本身 —— 真值，于是 publicAssetUrl 把它拼成 "[object Object]"，产出一个坏 URL。
 * 挡在入口最省事：挡住了 posterKey / backdropKey 就永远不会是这三个词，读取侧
 * 也就不会去查它们。
 */
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function imageKey(value: unknown): string | null {
  const key = text(value);
  if (!key || RESERVED_KEYS.has(key)) return null;
  return IMAGE_KEY.test(key) ? key : null;
}

function reportItem(value: unknown): ReportItem | null {
  const raw = object(value);
  const id = text(raw?.id);
  if (!raw || !id) return null;

  return {
    id,
    name: text(raw.name) ?? "",
    type: text(raw.type),
    serverId: text(raw.serverId),
    seriesName: text(raw.seriesName),
    season: number(raw.season),
    episode: number(raw.episode),
    year: number(raw.year),
    progress: Math.min(100, Math.max(0, number(raw.progress) ?? 0)),
    playedAt: text(raw.playedAt),
    posterKey: imageKey(raw.posterKey),
    backdropKey: imageKey(raw.backdropKey),
  };
}

function normalizeType(type: string | null): WatchingItem["type"] {
  if (type === "Episode" || type === "Movie" || type === "Series") return type;
  return "Other";
}

/**
 * 跳转链接指向 EMBY_PUBLIC_URL，那是浏览器能访问到的地址。
 * 没配就不给链接 —— 这里再没有内网地址可退，退了也是个点不开的链接。
 */
function link(item: ReportItem): string | null {
  const base = (process.env.EMBY_PUBLIC_URL ?? "").replace(/\/+$/, "");
  if (!base || !item.id) return null;
  // 两个 id 都是代理原样转来的任意字符串，不编码的话带 # / & / 空格的那些会把
  // 后面的查询串截断，拼出一个点不开的链接
  const id = encodeURIComponent(item.id);
  const server = item.serverId ? `&serverId=${encodeURIComponent(item.serverId)}` : "";
  return `${base}/web/index.html#!/item?id=${id}${server}`;
}

function normalize(item: ReportItem): StoredWatchingItem {
  let title: string;
  let subtitle: string;

  if (item.type === "Episode") {
    // 剧集展示剧名当标题，「S1:E5 - 集标题」当副标题
    title = item.seriesName || item.name;
    const label =
      item.season != null && item.episode != null
        ? `S${item.season}:E${item.episode}`
        : item.episode != null
          ? `E${item.episode}`
          : null;
    subtitle = [label, item.name].filter(Boolean).join(" · ");
  } else {
    title = item.name;
    subtitle = item.year != null ? String(item.year) : "";
  }

  return {
    id: item.id,
    title,
    subtitle,
    progress: item.progress,
    posterKey: item.posterKey,
    backdropKey: item.backdropKey,
    type: normalizeType(item.type),
    year: item.year,
    link: link(item),
    playedAt: item.playedAt,
  };
}

/**
 * 接收上报器已经写入 R2 的对象键；站点不再接触图片字节。
 *
 * 映射由调用方读好传进来 —— 那条读要和续播列表、播放中那两条一起发车。
 * 没有新落地的图时返回的就是传进来那个对象；有的话返回的是**落库后的那一份**
 * （setImageObjectKeys 会按 IMAGE_LIMIT 裁），不是就地改过的那个：超限时被淘汰
 * 掉的键必须在这次的回执和推送里就体现出来，否则推给浏览器的那份会引用刚被丢掉
 * 的键，代理也不会从 missingImages 里知道要补，下一轮又变回裂图。
 *
 * 确认走并发：`hasStoredImage` 未命中 5 分钟正缓存时要跨网发一次 R2 HEAD，而
 * recordEmbyReport 整段压在 202 之前。一次补图可以带一整批（IMAGE_LIMIT = 96），
 * 首次上报或桶被清空后是全量未命中，串着做几十次很容易撞上代理 30 秒的耐心
 * （见 lib/ingest-relay）。这些 HEAD 之间互不相干。
 */
async function storeImages(
  value: unknown,
  objectKeys: Record<string, string>,
): Promise<{ objectKeys: Record<string, string>; stored: number }> {
  if (!Array.isArray(value) || !value.length) return { objectKeys, stored: 0 };

  const candidates: { key: string; objectKey: string }[] = [];
  for (const entry of value) {
    const raw = object(entry);
    // imageKey 是 Emby 侧的键（itemId:kind:tag:height），objectKey 是 R2 上那份
    // 字节的内容地址。两个键挨在一起，名字必须各自说清是谁的键。
    const key = imageKey(raw?.imageKey);
    if (!key || !raw) continue;

    const objectKey = text(raw.objectKey);
    if (!objectKey || !IMAGE_OBJECT_KEY.test(objectKey)) continue;
    candidates.push({ key, objectKey });
  }
  if (!candidates.length) return { objectKeys, stored: 0 };

  const confirmed = await Promise.all(
    candidates.map((candidate) => hasStoredImage(candidate.objectKey)),
  );

  let stored = 0;
  candidates.forEach((candidate, index) => {
    if (!confirmed[index]) return;
    // 重新插入，让它排到末尾：淘汰的总是最久没被推过的那些
    delete objectKeys[candidate.key];
    objectKeys[candidate.key] = candidate.objectKey;
    stored += 1;
  });

  if (!stored) return { objectKeys, stored };
  return { objectKeys: await setImageObjectKeys(objectKeys), stored };
}

/** 引用了却还没有图的键。回给代理，让它下一次把这些补上 */
function missingKeys(items: StoredWatchingItem[], objectKeys: Record<string, string>): string[] {
  const missing = new Set<string>();
  for (const item of items) {
    for (const key of [item.posterKey, item.backdropKey]) {
      if (key && !objectKeys[key]) missing.add(key);
    }
  }
  return [...missing];
}

/**
 * 收下推送代理的一次上报。
 *
 * 三个部分都可省略，各推各的：续播列表 60 秒一轮且只在有变化时推，播放位置
 * 只在拖动进度条偏离推算值时推，图片则只在没推过或 ImageTag 变了时才带。
 */
export async function recordEmbyReport(body: unknown) {
  const root = object(body);
  if (!root) throw new Error("请求体不是对象");

  const writes: Promise<unknown>[] = [];
  const events: PendingEvent[] = [];
  const tags: string[] = [];

  /**
   * 这次用得着的三个键一起发车。
   *
   * 同一条连接上并发的命令在网络上是重叠的，加起来只花一个来回。从前是
   * 「读图片映射 → 读续播列表 → …→ 读播放中那一项」，三个背靠背，而它们
   * 互不相干。三个都读满：图片映射两份 payload 都要用，续播列表既要 diff
   * 又是 missingImages 的底，播放中那一项在代理只推了个位置更新时要拿来配详情。
   */
  const resume = object(root.resume);
  const [images, previousResume, storedCurrent] = await Promise.all([
    getImageObjectKeys(),
    getResume(),
    "playing" in root ? getCurrentItem() : null,
  ]);

  const { objectKeys, stored } = await storeImages(root.images, images);

  let list: StoredWatchingItem[] | null = null;
  /**
   * 列表内容变没变。代理只在有变化时推列表，但每 10 分钟还会兜底整推一次，
   * 收到就发失效通知的话推送会退化成定时广播，所以这里自己比一遍。
   */
  let resumeChanged = false;
  if (resume && Array.isArray(resume.items)) {
    list = resume.items
      .map(reportItem)
      .filter((item): item is ReportItem => item != null)
      .map(normalize);
    resumeChanged = JSON.stringify(previousResume?.items) !== JSON.stringify(list);
    writes.push(setResume(list));
  }

  /**
   * `playing` 缺席和为 null 是两回事：缺席表示这次不谈播放状态（比如只补图），
   * null 表示代理确认没有会话在播了，要清掉。所以判存在而不是判真假。
   */
  const played = "playing" in root ? preparePlaying(root.playing) : null;
  if (played) {
    writes.push(played.commit());
    // 播放状态变了就直接把新数据推给浏览器 —— 手上这份就是最新的
    events.push({
      type: "watching-now",
      payload: nowWatchingPayload(
        resolveNowPlaying(played.state),
        // 这次没带详情就用存着的那份；对不上会被 nowWatchingPayload 挡掉
        played.item ?? storedCurrent?.item ?? null,
        objectKeys,
      ),
    });
    tags.push(NOW_WATCHING_TAG);
  }

  /**
   * 缺哪些图要按「落地后的全部状态」算，而不是只看这次推来的部分：
   * Redis 被清空时代理往往只推了个位置更新，得靠这份回执才知道图也没了。
   *
   * 这次带了列表就用手上这份 —— 它正是要写下去的那份，读回来只会更慢，
   * 还可能读到写之前的。
   */
  const referenced = list ?? previousResume?.items ?? null;
  const current = played?.item ?? null;
  const missing = missingKeys(
    [...(referenced ?? []), ...(current ? [current] : [])],
    objectKeys,
  );

  /**
   * 列表也带整份数据推（2.8 KB），理由见 lib/live-events 的事件定义。
   *
   * 新落地的图片也要发。列表里存的是图片键、地址在读取时才拼，所以图片单独补推
   * 的那一次 resume 根本没变，但 /api/status/watching 的输出确实变了（裂图变成
   * 封面）—— 不发的话得等下一轮轮询，而列表的轮询现在是 5 分钟一次。
   */
  if ((resumeChanged || stored > 0) && referenced) {
    events.push({ type: "watching", payload: watchingPayload(referenced, objectKeys) });
    tags.push(WATCHING_TAG);
  }

  // 落库和推送同时发车，失效等它们完成，见 lib/live-events 的 fanout
  await fanout({ writes, events, tags });

  return { items: list?.length ?? null, playing: played?.outcome ?? null, images: stored, missingImages: missing };
}

/**
 * `missingImages` 回的是**本部署**引用了却没有的键，不再并对端那份。
 *
 * 从前取并集：两份部署各有各的 `imageKey → objectKey` 映射，「引用了但没有」是
 * 各算各的。代价是每一条上报都要等一次跨海往返，而两边只在**转发丢了**的时候才
 * 会不一样 —— 正常情况下对端算的是同一份请求体，答案必然一致。转发现在不等了
 * （见 lib/api 的 ingestRoute），这份并也就无从谈起。
 *
 * 放弃的是「转发丢了之后把对端那张裂图修回来」：代理把没被抱怨的键当成已经收下
 * （见 reporters/emby-reporter 的 deliver），所以没人提就不会重传。注意 COS 回源
 * 救不了这一种 —— 回源救的是「有 URL 但桶里没字节」，而对端缺的是映射本身，
 * 它根本拼不出 URL。但转发丢了的话对端缺的是那次上报的全部内容，不止图。
 */

/** 收下一次播放状态：先算，写留给 commit。`state` 为 null 表示没有会话在播了 */
function preparePlaying(value: unknown): {
  outcome: "updated" | "cleared";
  state: EmbyNowPlaying | null;
  item: StoredWatchingItem | null;
  commit: () => Promise<void>;
} {
  const raw = object(value);
  const itemId = text(raw?.itemId);
  if (!raw || !itemId) {
    return { outcome: "cleared", state: null, item: null, commit: clearNowPlaying };
  }

  const reported = reportItem(raw.item);
  const item = reported ? normalize(reported) : null;
  /**
   * 时间戳取本站收到的时刻，不用代理给的。
   * 进度是从这个锚点按真实时间往前推算的，两台机器的时钟差多少，推算就偏多少。
   */
  const state: EmbyNowPlaying = {
    itemId,
    paused: raw.paused === true,
    positionTicks: number(raw.positionTicks) ?? 0,
    runTimeTicks: number(raw.runTimeTicks) ?? 0,
    device: text(raw.device) ?? "",
    at: Date.now(),
  };

  return {
    outcome: "updated",
    state,
    item,
    commit: async () => {
      await Promise.all([item ? setCurrentItem(item) : null, setNowPlaying(state)]);
    },
  };
}
