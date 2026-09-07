import { requestState } from "@shared/request-state";
import { get, put, remove } from "@/lib/cache";

/**
 * music.apple.com 网页播放器那份 **web token**，以及拿它打 amp-api 的那一下。
 *
 * 这是站点两条 Apple 凭据里「不值钱」的那条：从网页的 JS bundle 里扒出来的公开
 * JWT，一分钱订阅都不带，谁都扒得到。它能打的是 amp-api（Apple 网页播放器自己
 * 用的内部端点）—— 动态封面的 `editorialVideo`、歌词的 `syllable-lyrics` 这些
 * **公开目录 API 不给**的扩展属性只在那儿有。另一条是 Mac 上报器推来的
 * MusicKit 凭据（lib/apple-music-credentials），那条锁在 TELEMETRY_INGEST_SECRET
 * 后面，别混用。
 *
 * 从动态封面（lib/motion-artwork）里抽出来的：歌词也要走同一份 token、同一套
 * 401 作废逻辑，两处各扒一遍就是两份缓存、两个刷新点，401 时还得各清各的。
 *
 * 三层缓存：模块全局（serverless 上即每实例一份）→ SQLite（全站共享）→ 真扒。
 * 扒取是这条链路最脆的一环 —— 从数据中心 IP 反复抓 music.apple.com 的页面和
 * JS bundle，Apple 哪天上验证页或改打包产物路径就断。共享进 SQLite 后，全站扒取
 * 频率从「每个冷实例一次」降到「每个半衰期一次」。
 */

let cachedToken: string | null = null;
let tokenExpiresAt = 0;
/**
 * 正在取 token 的那一次。in-flight 去重是进程内的：它挡的是冷启动后的一批并发
 * 请求各自把整个 JS bundle（几百 KB）扒一遍。
 */
const tokenRequest = () => requestState("web-token", () => ({ inflight: null as Promise<string> | null }));

/** Storage 里那份共享 web token 的键。两份生产各自的 Storage 各存一份 */
const TOKEN_CACHE_KEY = "apple-web-token";

type StoredToken = { token: string; expiresAt: number };

export const APPLE_WEB_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** 上游卡住时别把这次请求一起拖死 */
export const APPLE_UPSTREAM_TIMEOUT_MS = 10_000;

/** 上游（music.apple.com / amp-api）没给出正常回答。区别于「上游明确说没有」 */
export class AppleUpstreamError extends Error {
  constructor(
    message: string,
    /** amp-api 的 HTTP 状态码；扒 token 那一步没有，为 null */
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

export async function getWebToken(): Promise<string> {
  // 刷新时刻已经定在半衰期（见 tokenRefreshAt），不再需要「提前 5 分钟」的边距
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  tokenRequest().inflight ??= loadWebToken().finally(() => {
    tokenRequest().inflight = null;
  });
  return tokenRequest().inflight!;
}

/**
 * 先问 SQLite，没有才真扒。
 *
 * SQLite 不可达时 get 返回 undefined，静默落回本实例自己扒 —— token 读取失败
 * 不能把整个解析拖死，代价只是回到从前的每实例一扒。
 */
async function loadWebToken(): Promise<string> {
  const stored = await get<StoredToken>(TOKEN_CACHE_KEY);
  if (stored?.token && Date.now() < stored.expiresAt) {
    cachedToken = stored.token;
    tokenExpiresAt = stored.expiresAt;
    return stored.token;
  }

  const token = await scrapeWebToken();
  await put(TOKEN_CACHE_KEY, { token, expiresAt: tokenExpiresAt }, tokenExpiresAt - Date.now());
  return token;
}

/**
 * 从 music.apple.com 的 JS bundle 里扒一份 web token。
 *
 * 两次 fetch 都判 `.ok` 并把状态码写进错误里：上游返回 503 错误页时正则同样
 * 匹配不上，不判的话「Apple 改了打包产物路径」和「Apple 这会儿在抽风」会给出
 * 同一句 `No JS bundle`，排障时分不开。
 */
async function scrapeWebToken(): Promise<string> {
  const htmlResp = await fetch("https://music.apple.com", {
    headers: { "User-Agent": APPLE_WEB_USER_AGENT },
    signal: AbortSignal.timeout(APPLE_UPSTREAM_TIMEOUT_MS),
  });
  if (!htmlResp.ok) throw new AppleUpstreamError(`music.apple.com ${htmlResp.status}`);
  const html = await htmlResp.text();
  const jsMatch = html.match(/\/assets\/index~[^"']+\.js/);
  if (!jsMatch) throw new AppleUpstreamError("No JS bundle");

  const jsResp = await fetch("https://music.apple.com" + jsMatch[0], {
    headers: { "User-Agent": APPLE_WEB_USER_AGENT },
    signal: AbortSignal.timeout(APPLE_UPSTREAM_TIMEOUT_MS),
  });
  if (!jsResp.ok) throw new AppleUpstreamError(`JS bundle ${jsResp.status}`);
  const jsContent = await jsResp.text();
  const jwtMatch = jsContent.match(/eyJ[A-Za-z0-9_\-=]+\.[A-Za-z0-9_\-=]+\.[A-Za-z0-9_\-=]+/);
  if (!jwtMatch) throw new AppleUpstreamError("No JWT");

  cachedToken = jwtMatch[0];
  tokenExpiresAt = tokenRefreshAt(parseJwtExp(cachedToken));
  return cachedToken;
}

/**
 * 刷新时刻定在 JWT 的半衰期：寿命过半就换新，永远不贴着过期线跑。
 * 解不出 exp 时 parseJwtExp 兜底 +24h，半衰期即 +12h。下限一小时 ——
 * 万一扒来的 token 的 exp 已在过去，别让它当场失效，否则每个请求都会
 * 重扒一遍同样的坏 token。
 */
function tokenRefreshAt(expMs: number): number {
  const now = Date.now();
  // 取整：/2 有一半概率除出 x.5，而这个值既存进 SQLite 也当 TTL 用
  return now + Math.max(Math.ceil((expMs - now) / 2), 60 * 60 * 1000);
}

function parseJwtExp(jwt: string): number {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2 || !parts[1]) return Date.now() + 24 * 60 * 60 * 1000;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      exp?: number;
    };
    if (payload.exp && typeof payload.exp === "number") {
      return payload.exp * 1000;
    }
  } catch {}
  return Date.now() + 24 * 60 * 60 * 1000;
}

/**
 * 打一次 amp-api。上游没给出正常回答就抛，别把它和「上游说没有」混成同一个 null。
 * 抛出的错误带状态码：404 对歌词那条路有专门含义（见 lib/lyrics），调用方要认。
 *
 * `headers` 给需要多带一个头的调用方 —— 歌词要 `Media-User-Token`（amp-api 认的
 * 是这个名字，和 api.music.apple.com 的 `Music-User-Token` 不是一回事，别去统一）。
 *
 * **401 清 token，但只清「挨了这记 401 的那份」。** 清本身是老教训：从前只有
 * `/album/` 那条路清，`/song/` 那条静默返回 null，token 一失效那条路会一直
 * 失败到 tokenExpiresAt 自然到期。带条件比对是 SQLite 共享后补的：翻新窗口里
 * 拿旧 token 的请求还在天上飞，它们的迟到 401 若无条件清，会把别的实例刚扒好
 * 写进 SQLite 的新 token（或本实例已翻新的全局）一并作废，害下一个冷实例白扒
 * 一遍。GET 和 DEL 之间残留毫秒级窗口，撞上的代价也只是多扒一次，不上锁。
 */
export async function ampFetch<T>(
  endpoint: string,
  token: string,
  headers: Record<string, string> = {},
): Promise<T> {
  const resp = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: "https://music.apple.com",
      "User-Agent": APPLE_WEB_USER_AGENT,
      ...headers,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(APPLE_UPSTREAM_TIMEOUT_MS),
  });

  if (!resp.ok) {
    if (resp.status === 401) {
      /*
       * 全局那份放到最后清。反过来（先清全局再 await SQLite）的话，等待的
       * 那个来回里，同实例的并发请求会从还没删掉的 SQLite 把这个已判死的
       * token 重新装回全局 —— 随后 SQLite 被删空、快路径却一直用死 token。
       * 挪到 await 之后重读现值，复活了也当场抓回来。
       */
      const stored = await get<StoredToken>(TOKEN_CACHE_KEY);
      if (stored?.token === token) await remove(TOKEN_CACHE_KEY);
      if (cachedToken === token) cachedToken = null;
    }
    throw new AppleUpstreamError(`amp-api ${resp.status}`, resp.status);
  }

  return (await resp.json()) as T;
}
