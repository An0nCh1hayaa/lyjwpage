import { commit } from "@/lib/build-info";
import { site } from "@/lib/site";
import { workerUrl } from "@/lib/worker-url";

/**
 * MusicKit JS 这一侧的全部脏活：把 Apple 那份脚本弄进页面、拿到 developer
 * token、配出一个实例。跟随播放的逻辑不在这里，见 hooks/use-listen-along。
 *
 * developer token 由 workers/musickit-token 现签，站点自己不碰 .p8 —— 和
 * lib/apple-music 那条一样，私钥不进站点的运行时。区别是那条走的是 Mac 上报器
 * 推来的**私人凭据**（带 music user token，能读我的收听记录，锁在
 * TELEMETRY_INGEST_SECRET 后面），这条是发给**任意访客**的公开令牌，访客拿它去
 * 换自己那份用户令牌。两者敏感度差一个量级，所以不共用一条路径。
 */

/**
 * 签发服务（workers/musickit-token）的地址，令牌在 /token 上。
 *
 * 和另外两个 Worker 一样只配源，拼接规则见 lib/worker-url。必须写成完整的
 * `process.env.XXX` 字面量：浏览器那侧没有 process，这一处是构建时按文本替换掉
 * 的，解构或动态取键都替换不到。
 *
 * 没配就整体停用 —— 「一起听」是附加功能，卡片其余部分照常，不留写死的兜底地址
 * （那等于把某一份部署的地址塞进所有部署）。
 */
export const MUSICKIT_TOKEN_ENDPOINT = workerUrl(
  process.env.NEXT_PUBLIC_MUSICKIT_TOKEN_URL,
  "/token",
);

const MUSICKIT_SRC = "https://js-cdn.music.apple.com/musickit/v3/musickit.js";

/** MusicKit 的播放状态枚举，只列用得上的几个。数值是 Apple 定的，别改 */
export const PLAYBACK_STATE = {
  none: 0,
  loading: 1,
  playing: 2,
  paused: 3,
  stopped: 4,
  ended: 5,
  seeking: 6,
  waiting: 8,
  stalled: 9,
} as const;

/** PlayerRepeatMode：none 不循环，one 单曲循环。数值是 Apple 定的 */
export const REPEAT_MODE = {
  none: 0,
  one: 1,
} as const;

/** 主人单曲循环时这边也循环这一首，并关掉 autoplay，免得接下首 */
export function applyRepeatMode(music: MusicKitInstance, repeatOne: boolean) {
  if ("repeatMode" in music) {
    music.repeatMode = repeatOne ? REPEAT_MODE.one : REPEAT_MODE.none;
  }
  if ("autoplayEnabled" in music) music.autoplayEnabled = !repeatOne;
}

/** 队列条目上用得到的属性。Apple 没发布类型包，按官方文档手写 */
export type MediaItemAttributes = {
  name?: string;
  artistName?: string;
  albumName?: string;
  /** 毫秒 */
  durationInMillis?: number;
  /** 模板 URL，尺寸由取图的一侧填，见 lib/apple-artwork */
  artwork?: { url?: string };
  url?: string;
  /** 目录说这首有没有歌词。和 NowListeningPayload.hasLyrics 同一个来源，没有就不去问 /api/lyrics */
  hasLyrics?: boolean;
};
export type MediaItem = { id?: string; attributes?: MediaItemAttributes };
/** setQueue 接受的几种形态，只列用到的。startTime 被否决（见下面接口上的注释），别加回来 */
export type QueueOptions = {
  song?: string;
  album?: string;
  playlist?: string;
  station?: string;
  /** Apple Music 网页地址，专辑 / 歌单 / 电台都认 */
  url?: string;
  /** 队列装好就开始放 */
  startPlaying?: boolean;
};

/** 用到的那部分 MusicKit 实例接口。Apple 没发布类型包，按官方文档手写 */
export type MusicKitInstance = {
  isAuthorized: boolean;
  storefrontId?: string;
  /** 见 PLAYBACK_STATE */
  playbackState: number;
  /** 播放进度，**秒**（站点内部一律毫秒，边界在 use-listen-along 里换算） */
  currentPlaybackTime: number;
  /** 当前曲总长，**秒**，和 currentPlaybackTime 同一个单位 */
  currentPlaybackDuration: number;
  /** 0–1 */
  volume: number;
  nowPlayingItem: MediaItem | null;
  queue?: { items?: MediaItem[] };
  /** 队列里有下一首时让它自己接着播。单曲循环时要关掉，否则会去接下首 */
  autoplayEnabled?: boolean;
  /** 见 REPEAT_MODE。单曲循环是 one，跟听平时是 none */
  repeatMode?: number;
  api?: {
    music?: (
      path: string,
      query?: Record<string, unknown>,
    ) => Promise<{ data?: { data?: unknown[]; [key: string]: unknown } | unknown[] }>;
  };
  authorize(): Promise<string>;
  unauthorize(): Promise<void>;
  /*
   * 只声明用到的形态。文档上还有 songs / startPlaying / startTime 等旋钮 ——
   * startTime 是被否决的 seek 起播方案（换歌一律从 0 走，见 use-listen-along），
   * 别把它标回接口上邀请人用回去。
   */
  setQueue(options: QueueOptions): Promise<unknown>;
  playNext(options: { song?: string }, clear?: boolean): Promise<unknown>;
  playLater(options: { song?: string }): Promise<unknown>;
  skipToNextItem(): Promise<void>;
  skipToPreviousItem(): Promise<void>;
  changeToMediaAtIndex(index: number): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  seekToTime(seconds: number): Promise<void>;
  addEventListener(name: string, handler: (event: unknown) => void): void;
  removeEventListener(name: string, handler: (event: unknown) => void): void;
};

type MusicKitGlobal = {
  configure(config: {
    developerToken: string;
    app: { name: string; build: string };
    /** 授权弹窗和目录返回的语言 */
    storefrontId?: string;
  }): Promise<MusicKitInstance>;
};

declare global {
  interface Window {
    MusicKit?: MusicKitGlobal;
  }
}

/**
 * 脚本只插一次，结果记在模块作用域里。
 *
 * 手动插而不用 next/script：它那四种 strategy 说的都是「什么时候自动加载」，
 * 没有「点了才加载」这一档。而 MusicKit JS 是个几百 KB 的第三方包，绝大多数
 * 访客根本不会点这个按钮，连 lazyOnload 那种空闲期预载都是白花的流量。
 *
 * 存的是 Promise 而不是加载完的标志位：两张卡片（或 React 严格模式下的两次
 * effect）同时要它时，第二个等的是同一次加载，而不是再插一个 script 标签。
 * 失败时把它清掉，让下一次点击能重试 —— 网络抖一下不该让按钮永久失效。
 */
let scriptPromise: Promise<MusicKitGlobal> | null = null;

function loadMusicKitScript(): Promise<MusicKitGlobal> {
  if (window.MusicKit) return Promise.resolve(window.MusicKit);
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<MusicKitGlobal>((resolve, reject) => {
    /*
     * 两条路都要接：脚本自己会在挂好 window.MusicKit 之后派发 musickitloaded，
     * 但如果它在我们挂监听之前就跑完了（缓存命中时真的会），那个事件就错过了。
     * 所以 onload 里再查一次全局，谁先到算谁。
     */
    const settle = () => {
      if (!window.MusicKit) return false;
      document.removeEventListener("musickitloaded", onLoaded);
      resolve(window.MusicKit);
      return true;
    };
    const onLoaded = () => settle();
    document.addEventListener("musickitloaded", onLoaded);

    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${MUSICKIT_SRC}"]`,
    );
    const script = existing ?? document.createElement("script");
    script.addEventListener("load", () => {
      // 事件可能比 load 晚一点点，没挂上就继续等 musickitloaded
      settle();
    });
    script.addEventListener("error", () => {
      document.removeEventListener("musickitloaded", onLoaded);
      scriptPromise = null;
      reject(new Error("MusicKit 脚本没加载起来"));
    });

    if (!existing) {
      script.src = MUSICKIT_SRC;
      script.async = true;
      document.head.appendChild(script);
    }
  });

  return scriptPromise;
}

export type DeveloperToken = {
  token: string;
  /** 签发时刻，Unix **秒**，和 JWT 的 iat 同一个值 */
  issuedAt: number;
  /** 到期时刻，Unix **秒**，和 JWT 的 exp 同一个值 */
  expiresAt: number;
};

/**
 * 过了「签发时刻 → 到期时刻」的中点就该换一份新的。
 *
 * 和 Worker 那侧逐字同一条规则（workers/musickit-token/src/index.ts 里也叫
 * pastHalfLife），改一处记得对齐。用 issuedAt 而不是「我什么时候收到的」当起点：
 * Worker 自己也缓存，拿到手的可能已经是一份用掉一半的令牌。
 */
function pastHalfLife(token: DeveloperToken, now: number): boolean {
  return now >= token.issuedAt + (token.expiresAt - token.issuedAt) / 2;
}

/** 令牌上的两个时刻都是 Unix 秒，比之前先换算过来 */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * 令牌在内存里留一份，过了半衰期再去要。
 *
 * Worker 那侧也缓存，但那是**每个 isolate** 各存各的；这里省的是每次开始跟听都
 * 打一次网络。
 */
let cachedToken: DeveloperToken | null = null;

export async function fetchDeveloperToken(): Promise<DeveloperToken> {
  if (!MUSICKIT_TOKEN_ENDPOINT) throw new Error("没有配置 MusicKit 令牌签发地址");

  if (cachedToken && !pastHalfLife(cachedToken, nowSeconds())) return cachedToken;

  const response = await fetch(MUSICKIT_TOKEN_ENDPOINT, { cache: "no-store" });
  if (!response.ok) {
    /*
     * Worker 的报错原文带出来。403 说的是「这个域名不在名单里」，500 说的是
     * 「哪个变量没配」—— 两者都只有部署的人能修，吞掉就得去翻 Worker 日志。
     */
    const detail = await response
      .json()
      .then((body: { error?: string }) => body.error)
      .catch(() => null);
    throw new Error(detail || `令牌签发服务返回 ${response.status}`);
  }

  const token = (await response.json()) as DeveloperToken;
  if (!token.token) throw new Error("令牌签发服务没有返回令牌");
  // 两个时刻缺一个就算不出半衰期，那样这份会被当成永远新鲜或永远过期
  if (!Number.isFinite(token.issuedAt) || !Number.isFinite(token.expiresAt)) {
    throw new Error("令牌签发服务没有给出签发 / 到期时刻");
  }
  cachedToken = token;
  return token;
}

/**
 * 配好的单例。
 *
 * MusicKit 全局只有一个实例，configure 调第二次会顶掉第一次的配置，所以这里也
 * 用同一个 Promise 兜住并发调用。
 */
let instancePromise: Promise<MusicKitInstance> | null = null;

export function getMusicKit(): Promise<MusicKitInstance> {
  /*
   * 手上那份过了半衰期就重新配一遍。
   *
   * 光在 fetchDeveloperToken 里判是不够的：实例配好之后这个 Promise 一直留着，
   * 那个函数再也不会被调到，于是页面开着不动时令牌永远不换 —— 一直开到过期，
   * 跟听就断在那里。清掉重来会走一遍 fetchDeveloperToken，它自己会看出手上那份
   * 该换了。
   *
   * 两个调用方都保证调到这里时没在放：「一起听」只在 start() 调（在放的话按钮是
   * 「跟听中」，点了走的是 stop）；网页播放器（hooks/use-web-player）手里的实例
   * 还在放时直接复用、不再来要，见那边的 getOrReuseMusicKit。所以重配不会打断谁。
   */
  if (instancePromise && cachedToken && pastHalfLife(cachedToken, nowSeconds())) {
    instancePromise = null;
  }
  if (instancePromise) return instancePromise;

  instancePromise = (async () => {
    const [MusicKit, developer] = await Promise.all([
      loadMusicKitScript(),
      fetchDeveloperToken(),
    ]);
    const instance = await MusicKit.configure({
      developerToken: developer.token,
      // 这两个字段会出现在访客的 Apple ID 授权弹窗里，得是人看得懂的东西
      app: { name: site.name, build: commit?.short ?? "dev" },
    });
    applyRepeatMode(instance, false);
    return instance;
  })().catch((error: unknown) => {
    // 失败不留缓存，否则第一次网络抖动之后按钮就再也点不动了
    instancePromise = null;
    throw error;
  });

  return instancePromise;
}
