export interface Env {
  /** .p8 私钥全文。带不带 PEM 头尾、换行是真的还是 `\n` 都能吃，见 importSigningKey */
  APPLE_MUSIC_PRIVATE_KEY?: string;
  /** 私钥的 Key ID，10 位。Apple Developer 后台建 MusicKit 密钥时给的 */
  APPLE_MUSIC_KEY_ID?: string;
  /** Team ID，10 位。签发者（JWT 的 iss） */
  APPLE_MUSIC_TEAM_ID?: string;
  /** 逗号分隔的允许来源。**这份名单同时是访问闸门和 JWT 里的 origin 声明**，见 signedOrigins */
  ALLOWED_ORIGINS?: string;
  /** 令牌有效期（秒）。不填按 DEFAULT_TTL_SECONDS */
  TOKEN_TTL_SECONDS?: string;
}

const TOKEN_PATH = "/token";
const LOCAL_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;

/**
 * 七天。
 *
 * Apple 允许最长半年，但这个令牌是发给任何一个打开页面的访客的 —— 它一旦被复制
 * 走，域名限制之外就只剩有效期这一道闸，所以不取上限。
 */
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Apple 的硬上限：15777000 秒 ≈ 半年。签超了对方直接拒 */
const MAX_TTL_SECONDS = 15777000;

/*
 * 下面四个来源匹配函数和 ingest 那个 worker 逐字一样
 * （workers/api/src/index.ts），改一处记得同步另一处。
 *
 * 没抽成共享包是故意的：域名名单本来就得在每份 wrangler.toml 里各配一次，
 * 抽包省不掉那份重复，却要多一个包和一层依赖解析。
 */

function getAllowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * 允许 `https://*.vercel.app` 这样的后缀通配。
 *
 * Vercel 的预览域名每次部署都换一个（`lyjwpage-<hash>-....vercel.app`），
 * 只做全等匹配的话，预览环境永远拿不到令牌。
 *
 * 按 hostname 的后缀比，不是按字符串包含 —— 后者会把
 * `https://vercel.app.evil.com` 也放进来。
 */
function originMatches(origin: string, pattern: string): boolean {
  if (origin === pattern) return true;
  if (!pattern.includes("*")) return false;

  const wildcard = pattern.match(/^(https?:)\/\/\*\.(.+)$/);
  if (!wildcard) return false;
  const [, protocol, suffix] = wildcard;

  try {
    const url = new URL(origin);
    return url.protocol === protocol && url.hostname.endsWith(`.${suffix}`);
  } catch {
    return false;
  }
}

function isAllowedOriginValue(origin: string, allowed: string[]): boolean {
  if (LOCAL_ORIGIN_RE.test(origin)) return true;
  return allowed.some((pattern) => originMatches(origin, pattern));
}

/**
 * 没配 ALLOWED_ORIGINS 就不限制 —— `wrangler dev` 不配也要能跑，而 localhost
 * 本来就始终放行。**配了之后，不带 Origin 头一律拒绝**：浏览器发 fetch 时一定
 * 带这个头，所以卡死它对真实访客零代价，却堵上了「curl 不带头就绕过白名单」
 * 这个口子。
 *
 * 但别把这道闸当成全部的防护：Origin 头是请求方自己写的，非浏览器伪造一个就能
 * 过。真正兜底的是签进 JWT 的 origin 声明 —— 那份由 Apple 校验，令牌被复制到
 * 别的站点上也用不了。这道闸只是让「拿一份」这件事不那么随手。
 */
function isAllowedOrigin(request: Request, env: Env): boolean {
  const allowed = getAllowedOrigins(env);
  if (allowed.length === 0) return true;
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  return isAllowedOriginValue(origin, allowed);
}

function getCorsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers();
  const origin = request.headers.get("Origin");
  const allowed = getAllowedOrigins(env);
  if (origin && (allowed.length === 0 || isAllowedOriginValue(origin, allowed))) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  } else if (allowed.length === 0) {
    headers.set("Access-Control-Allow-Origin", "*");
  }
  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  return headers;
}

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  // 令牌带有效期，中间任何一层都不该替我们留着它
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * .p8 的内容解成 PKCS#8 的字节。
 *
 * 三种写法都要吃下来，因为它们都是人真的会填进去的：贴进 Cloudflare 后台的密钥
 * 框里是带真换行的整份 PEM；从 CI 的变量里传过来常常变成字面量 `\n`；有人则只
 * 贴中间那段 base64。头尾和所有空白一起剥掉，剩下的就是 base64 本体。
 */
function decodePkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

/**
 * 措辞可控、可以原文回给客户端的配置错误。
 *
 * 只有部署的人能修这类问题，所以提示要外带；但外带的文案只从 `hint` 取 ——
 * 它是我们自己写死的字符串，不是异常对象身上的 message / stack，任意运行时
 * 异常（importKey 的 DER 解析、平台错误）都不会顺着这条路漏出去。
 */
class ConfigError extends Error {
  readonly hint: string;
  constructor(hint: string) {
    super(hint);
    this.hint = hint;
  }
}

/**
 * 导入的私钥留在模块作用域里复用。
 *
 * 同一个 isolate 会连着服务很多请求，而 importKey 每次都要重新解析一遍 DER。
 * `extractable: false` —— 导进来之后连我们自己也读不回明文，少一条泄漏路径。
 */
let signingKey: CryptoKey | null = null;

async function importSigningKey(env: Env): Promise<CryptoKey> {
  if (signingKey) return signingKey;
  const raw = env.APPLE_MUSIC_PRIVATE_KEY?.trim();
  if (!raw) throw new ConfigError("没有配置 APPLE_MUSIC_PRIVATE_KEY");

  signingKey = await crypto.subtle.importKey(
    "pkcs8",
    decodePkcs8(raw),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return signingKey;
}

/**
 * 签进 JWT 的 origin 声明 —— 这个功能的域名限制真正落地的地方。
 *
 * Apple 只认写死的完整来源，通配符它不解析。所以名单里的通配项（`https://*.
 * vercel.app`）不能原样塞进去，得换成**这次来要令牌的那个来源**：它刚在
 * isAllowedOrigin 里比对通过，是一个已经确认合法的具体值。localhost 同理 ——
 * 它始终放行但不会出现在名单里，不补进去的话本地就调不动。
 *
 * **来路不是名单里写死的那几个时，只签它自己一个，不把生产域名一起捎上。**
 * 从前是把它*追加*到 literal 名单后面，于是：localhost 无条件放行
 * （isAllowedOriginValue），公网上任何人带一句 `Origin: http://localhost:3000`
 * 就能要走一份声明里含 lyjw.me / lyjw131.com 的令牌，在自己的页面上直接可用 ——
 * 等于把「真正兜底的那道」也一并交了出去。通配匹配到的预览域名同理：
 * `*.vercel.app` 底下并不都是我们的部署。
 *
 * 名单里写死的那几个仍然一起签：它们都是自家域名，共用一份令牌能共用一条
 * tokenCache 条目，省掉每个域各签一次。
 *
 * 返回空数组表示「不加这条声明」：一条都没配时（`wrangler dev`）签一个无限制的
 * 令牌，比签一个 origin 为空、Apple 一律拒收的令牌有用。
 */
function signedOrigins(request: Request, env: Env): string[] {
  const allowed = getAllowedOrigins(env);
  if (allowed.length === 0) return [];

  const literal = allowed.filter((pattern) => !pattern.includes("*"));
  const origin = request.headers.get("Origin");
  // 名单非空时 isAllowedOrigin 已经把不带 Origin 的请求拦下了，这条是防御
  if (!origin) return literal;
  return literal.includes(origin) ? literal : [origin];
}

function resolveTtlSeconds(env: Env): number {
  const raw = Number(env.TOKEN_TTL_SECONDS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TTL_SECONDS;
  return Math.min(Math.floor(raw), MAX_TTL_SECONDS);
}

type CachedToken = { token: string; issuedAt: number; expiresAt: number };

/**
 * 过了「签发时刻 → 到期时刻」的中点就该换一份新的。
 *
 * 取相对中点而不是写死提前量：改了 TOKEN_TTL_SECONDS 不用跟着调第二个数，
 * 而写死的那个在两个方向上都可能错 —— 对七天的令牌，提前五分钟等于几乎不续；
 * 对一小时的令牌，提前一天等于每次都续。
 *
 * 站点那侧判是不是该重新要一份用的是同一条规则（见 src/lib/musickit.ts 的
 * pastHalfLife），Mac 上报器续它自己那份 developer token 也是。改一处记得对齐。
 */
function pastHalfLife(token: CachedToken, now: number): boolean {
  return now >= token.issuedAt + (token.expiresAt - token.issuedAt) / 2;
}

/**
 * 按 origin 声明分开缓存。
 *
 * 声明不同的令牌不能互相顶替 —— 预览域名各签各的。键就用那串声明本身，省掉再
 * 造一个 ID。签名本身不贵，这里省的是每个请求都做一次 ECDSA 的那点延迟。
 *
 * 键里不带有效期：决定令牌内容的另外几样（TTL、Team ID、Key ID、私钥）都是部署
 * 期固定的，改了就是一次重新部署、isolate 连同这张表一起换掉。只有 `wrangler
 * dev` 热更 vars 时旧值会多活一会儿，不影响线上。
 */
const tokenCache = new Map<string, CachedToken>();
/**
 * 缓存条目的上限。预览域名一个部署换一个，isolate 活得够久的话这张表只增不减；
 * 满了就淘汰最早插入的那条（Map 按插入序遍历）。
 */
const TOKEN_CACHE_LIMIT = 32;

async function issueToken(request: Request, env: Env): Promise<CachedToken> {
  const teamId = env.APPLE_MUSIC_TEAM_ID?.trim();
  const keyId = env.APPLE_MUSIC_KEY_ID?.trim();
  if (!teamId) throw new ConfigError("没有配置 APPLE_MUSIC_TEAM_ID");
  if (!keyId) throw new ConfigError("没有配置 APPLE_MUSIC_KEY_ID");

  const origins = signedOrigins(request, env);
  const cacheKey = origins.join(",");
  const now = Math.floor(Date.now() / 1000);

  const cached = tokenCache.get(cacheKey);
  if (cached && !pastHalfLife(cached, now)) return cached;

  const expiresAt = now + resolveTtlSeconds(env);
  const header = { alg: "ES256", kid: keyId };
  const payload = {
    iss: teamId,
    iat: now,
    exp: expiresAt,
    // 空数组会被 Apple 当成「一个来源都不许」，没配名单时干脆不带这一条
    ...(origins.length > 0 ? { origin: origins } : {}),
  };

  const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(payload)}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    await importSigningKey(env),
    new TextEncoder().encode(signingInput),
  );

  /*
   * WebCrypto 的 ECDSA 签名出来就是 r‖s 的定长拼接（P-256 是 64 字节），正好是
   * JWS 要的那种。别在这里加 DER 封装 —— OpenSSL 那套输出的是 DER，两者不通用，
   * 混了 Apple 会以「签名不对」拒掉，而错误信息里看不出是编码问题。
   */
  const token = `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
  const issued = { token, issuedAt: now, expiresAt };
  if (tokenCache.size >= TOKEN_CACHE_LIMIT) {
    const oldest = tokenCache.keys().next().value;
    if (oldest !== undefined) tokenCache.delete(oldest);
  }
  tokenCache.set(cacheKey, issued);
  return issued;
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: getCorsHeaders(request, env) });
    }

    const url = new URL(request.url);
    const cors = getCorsHeaders(request, env);

    if (url.pathname !== TOKEN_PATH) {
      return jsonResponse({ error: `只有 ${TOKEN_PATH}` }, { status: 404, headers: cors });
    }
    if (request.method !== "GET") {
      return jsonResponse({ error: "只接受 GET" }, { status: 405, headers: cors });
    }
    if (!isAllowedOrigin(request, env)) {
      return jsonResponse({ error: "来源不在允许的域名内" }, { status: 403, headers: cors });
    }

    try {
      const { token, issuedAt, expiresAt } = await issueToken(request, env);
      // 两个时刻都给出去，站点那侧才算得出半衰期 —— 只给到期时刻的话，它只能拿
      // 「我什么时候收到的」当起点，而收到的可能已经是一份用掉一半的缓存
      return jsonResponse({ token, issuedAt, expiresAt }, { headers: cors });
    } catch (error) {
      /*
       * 只有自己抛的 ConfigError 原文外带（哪个变量没配，只有部署的人能修）；
       * 其余异常一律通用文案 —— importKey / 运行时抛出来的 message 内容不由
       * 我们控制，随手转发等于把内部细节交给任何一个能打到这个端点的人。
       * 完整原文进 Worker 日志，排障看那边。
       */
      console.error("[musickit-token] 签发失败：", error);
      const hint = error instanceof ConfigError ? error.hint : "签发失败，详情见 Worker 日志";
      return jsonResponse({ error: hint }, { status: 500, headers: cors });
    }
  },
};

export default worker;
