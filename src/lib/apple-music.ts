import { readAppleMusicCredentials } from "@/lib/apple-music-credentials";
import {
  catalogSearchTerms,
  normalizeForMatch,
  pickCatalogHit,
  type CatalogSong,
} from "@/lib/apple-music-lookup";
import { cached } from "@/lib/cache";

/**
 * 站点和 Apple Music 之间的往来：凭据、请求外壳，以及目录查询。
 *
 * 两个调用方，共用下面这把凭据和 `appleFetchRaw`：
 *
 * 1. **给此刻在播的那首曲子找一个可跳转的地址**（就在这个文件里）。本机
 *    Music.app 和 HomePod 都给不出可分享的链接，只能拿曲名 + 艺人去目录里搜，
 *    而这件事跟着当前播放的曲子走，读取时才知道要搜什么。真要把它搬走，该搬去
 *    Mac 上报器 —— 它有 MusicKit，换歌的那一刻就能把链接一起算好塞进信封，
 *    这里连缓存都不用留。
 * 2. **「最近在听」那份列表**（见 lib/apple-music-recent）。它从前由 NAS 上一个
 *    常驻的上报器拉好推来，现在收编进站点：访客的轮询驱动刷新，闲时不出网。
 *
 * 加上动态封面和歌词（lib/motion-artwork 和 lib/lyrics —— 那两条打的是 amp-api、
 * 用的是扒来的 web token，歌词再多带一个这里同一份凭据里的 music user token），
 * 站点会打 Apple 的就这四处。四处都命中缓存，前端轮询多快，回源频率都不变。
 *
 * 凭据只有一个来源：Mac 上报器推来的那份。服务器上不放 .p8 —— 签名密钥留在那台
 * 机器的钥匙串里由系统保管，这边拿到的是 MusicKit 现签的 developer token 和
 * 同一次授权产出的 music user token。没有本地签名的回落：有回落就意味着私钥
 * 仍然得躺在服务器上，那这套东西就白做了。
 *
 * 这份凭据也不再从任何 HTTP 端点发出去。从前 `/api/ingest/apple-music` 的 GET
 * 把它转交给上报器，代价是 `TELEMETRY_INGEST_SECRET` 从此和收听记录同等敏感；
 * 拉列表的活收回站点之后，那条路连同那个代价一起没了。
 */

export type Credentials = {
  developerToken: string;
  userToken: string;
  /** developer token 的到期时刻，Unix 秒。只用来在报错里说清楚，不做提前判断 */
  expiresAt: number;
};

/** 目录查询地区。两个调用方读的是同一个变量，别各写各的默认值 */
export function appleStorefront(): string {
  return (process.env.APPLE_MUSIC_STOREFRONT?.trim() || "cn").toLowerCase();
}

export async function resolveCredentials(): Promise<Credentials> {
  const result = await readAppleMusicCredentials();
  if (!result.ok) {
    // 两种没有，修法相反：一个去看 SQLite，一个去点授权按钮
    throw new Error(
      result.reason === "storage-unreachable"
        ? "读不到 Apple Music 凭据 —— Storage 连不上，凭据本身可能还在"
        : "没有收到 Mac 上报器的 Apple Music 凭据 —— 在上报器的设置里授权 Apple Music",
    );
  }
  const { credentials } = result;
  return {
    developerToken: credentials.developerToken,
    userToken: credentials.musicUserToken,
    expiresAt: credentials.expiresAt,
  };
}

/**
 * 上游卡住时别把这次请求一起拖死。
 *
 * 两条调用路径都需要它：查链接压在「此刻在听」的推送链路上，拉列表压在一次
 * 状态轮询的响应之后 —— 两处都不该为一个不回话的上游一直挂着。
 */
const UPSTREAM_TIMEOUT_MS = 10_000;

export async function appleFetchRaw<T>(url: string, credentials: Credentials): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${credentials.developerToken}`,
      "Music-User-Token": credentials.userToken,
      Accept: "application/json",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    // 带上标称到期时刻：401 多半就是上报器没能按时续上，写出来省一次排查
    const origin = `凭据来自 Mac 上报器，标称 ${new Date(credentials.expiresAt * 1000).toISOString()} 到期`;
    if (response.status === 401) {
      throw new Error(`Apple Music 拒绝了 developer token（401，${origin}）：${body}`);
    }
    if (response.status === 403) {
      throw new Error(`Music-User-Token 已失效，需要重新授权（403，${origin}）：${body}`);
    }
    throw new Error(`Apple Music 返回 ${response.status}：${body}`);
  }

  return (await response.json()) as T;
}

/** 命中的链接不会变，缓存久一点；搜不到时靠 cached 的负缓存挡住重复请求 */
const TRACK_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * 取满上限的候选。同一首歌可能同时收录在单曲、EP、精选里，相关度排序也不保证
 * 想要的那个版本排在前面，候选取少了正确的专辑可能根本不在集合里。
 */
const SEARCH_LIMIT = 25;

/**
 * 一次目录查询同时解出链接和封面。
 *
 * 封面顺带取回来是有实际意义的：以前封面是采集端把二进制压进上报载荷送上来的，
 * 而这次查询本来就要做、结果本来就带 artwork 模板 URL，等于白拿。
 * link 为空串表示「搜过了但没匹配上」，和「还没搜过」区分开。
 */
export type TrackLookup = {
  link: string;
  artwork: string | null;
  /** 与最近播放资源对应的专辑 ID。 */
  id: string | null;
  /**
   * 目录里那首**曲子本身**的 ID，和上面那个专辑 ID 是两个东西。
   *
   * 「一起听」拿它点播：MusicKit 要的是 songs 那个类型的资源 ID，喂专辑 ID
   * 会从第一首开始放。搜索命中的那条本来就带着它，等于白拿。
   */
  songId: string | null;
  /**
   * 目录说这首有没有歌词。搜不到时是 false —— 没有可查的东西。
   *
   * 歌词端点拿它当门：目录说没有就不去问 amp-api。那边的 404 分不清「没有」和
   * 「订阅身份没被认」，先把确实没有的挡在门外，剩下的 404 才好按短缓存处理。
   */
  hasLyrics: boolean;
};

/**
 * 把「播放中」的曲目解析成一个可跳转的 Apple Music 地址。
 *
 * 都对不上就退回搜索页：宁可给一个粗一点但正确的落点，也不给一个错的直链。
 * 缓存键带专辑名，否则同名不同专辑会互相命中对方的缓存。
 */
export async function resolveTrackLookup(track: {
  title: string | null;
  artist: string | null;
  album: string | null;
}): Promise<TrackLookup> {
  if (!track.title) return { link: "", artwork: null, id: null, songId: null, hasLyrics: false };

  const terms = catalogSearchTerms(track.title, track.artist, track.album);
  // 目录全没对上时的搜索页：已经失败了，链出去的词不再带艺人
  const searchUrl = `https://music.apple.com/search?term=${encodeURIComponent(terms.at(-1) ?? track.title)}`;

  // 专辑名必须进 key：同名同艺人但不同专辑是完全不同的链接
  /**
   * 键里带上格式版本。
   *
   * 这个缓存的值从「一个链接字符串」改成了 `{ link, artwork }` 对象，键不跟着
   * 换的话旧条目会被当成新格式读：字符串上取 `.link` 拿到的是
   * `String.prototype.link` 那个上古方法，它是真值，于是链接字段被塞进一个函数，
   * JSON 序列化时又被悄悄丢掉 —— 表现是链接和封面同时消失，很难往缓存上想。
   * 以后再改这个值的形状，记得一起改版本号。搜索策略变了也要改：旧键里缓存的
   * 「搜过了但没匹配上」会把新策略挡在门外整整一周。
   */
  const cacheKey =
    "apple-music:track-lookup:v10:" +
    [track.title, track.artist, track.album].map(normalizeForMatch).join(":");

  try {
    const exact = await cached<TrackLookup>(cacheKey, TRACK_LINK_TTL_MS, async () => {
      const credentials = await resolveCredentials();
      const storefront = appleStorefront();
      let hit: CatalogSong | undefined;

      for (const term of terms) {
        const url =
          `https://api.music.apple.com/v1/catalog/${storefront}/search` +
          `?term=${encodeURIComponent(term)}&types=songs&limit=${SEARCH_LIMIT}&relate=albums`;
        const json = await appleFetchRaw<{
          results?: { songs?: { data?: CatalogSong[] } };
        }>(url, credentials);
        hit = pickCatalogHit(json.results?.songs?.data ?? [], {
          title: track.title!,
          artist: track.artist,
          album: track.album,
        });
        if (hit) break;
      }

      let albumId = hit?.relationships?.albums?.data?.[0]?.id ?? null;
      if (hit?.id && !albumId) {
        // 搜索结果有时只带歌曲本身，歌曲所属专辑关系要从资源元数据里取。
        const detail = await appleFetchRaw<{ data?: CatalogSong[] }>(
          `https://api.music.apple.com/v1/catalog/${storefront}/songs/${hit.id}?relate=albums`,
          credentials,
        );
        albumId = detail.data?.[0]?.relationships?.albums?.data?.[0]?.id ?? null;
      }

      // link 存空串而不是 null：cached 用 undefined 判未命中，空串才能把
      // 「搜过了但没匹配上」这个结论也缓存住，不然每次都会重搜一遍
      return {
        link: hit?.attributes?.url ?? "",
        artwork: hit?.attributes?.artwork?.url ?? null,
        id: albumId,
        songId: hit?.id ?? null,
        hasLyrics: hit?.attributes?.hasLyrics === true,
      };
    });
    return {
      link: exact.link || searchUrl,
      artwork: exact.artwork,
      id: exact.id,
      songId: exact.songId,
      hasLyrics: exact.hasLyrics,
    };
  } catch {
    // 凭据缺失或上游异常都不该让整张卡片失败
    return { link: searchUrl, artwork: null, id: null, songId: null, hasLyrics: false };
  }
}
