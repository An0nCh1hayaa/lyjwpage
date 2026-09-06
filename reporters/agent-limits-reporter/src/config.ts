/**
 * 全部配置走环境变量 —— 这东西是要塞进一个 docker run 里跑的，
 * 配置文件还得挂卷，不如直接给变量。
 */

const KNOWN_AGENTS = ["claude", "codex", "grok", "cursor", "antigravity"] as const;
export type AgentId = (typeof KNOWN_AGENTS)[number];

function ms(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} 必须是正数`);
  return value;
}

function trimSlash(url: string) {
  return url.replace(/\/+$/, "");
}

function flag(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function agentIds(): AgentId[] {
  const raw = process.env.AGENT_IDS?.trim() || "claude,codex,grok,cursor,antigravity";
  const ids: AgentId[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim().toLowerCase();
    if (!id) continue;
    if (!(KNOWN_AGENTS as readonly string[]).includes(id)) {
      throw new Error(`AGENT_IDS 里有不认识的 id：${id}`);
    }
    if (!ids.includes(id as AgentId)) ids.push(id as AgentId);
  }
  if (ids.length === 0) throw new Error("AGENT_IDS 不能是空的");
  return ids;
}

const dryRun = flag("DRY_RUN");
const siteUrl = process.env.SITE_URL?.trim() ?? "";

export const config = {
  dryRun,

  site: {
    ingestUrl:
      process.env.SITE_INGEST_URL?.trim() ||
      (siteUrl ? `${trimSlash(siteUrl)}/api/ingest/agents` : ""),
    secret: process.env.TELEMETRY_INGEST_SECRET?.trim() ?? "",
  },

  /** 与 server / PlayStation 共用人数分档逻辑；限额使用 5 / 10 / 60 分钟。 */
  cadence: {
    liveIntervalMs: ms("LIVE_INTERVAL_MS", 300_000),
    openIntervalMs: ms("OPEN_INTERVAL_MS", 600_000),
    idleIntervalMs: ms("IDLE_INTERVAL_MS", 3_600_000),
    /** 人头数读上报那同一个 Worker 的 /count；只配了 SITE_INGEST_URL 就读不到，永远走闲档 */
    countUrl: siteUrl ? `${trimSlash(siteUrl)}/count` : "",
    countTimeoutMs: ms("COUNT_TIMEOUT_MS", 2_500),
  },
  pushTimeoutMs: ms("PUSH_TIMEOUT_MS", 30_000),

  /**
   * 两个都空时自动读取 Claude Code 安装包的生产配置；显式覆盖时必须一起填。
   */
  claudeOAuth: {
    tokenUrl: process.env.CLAUDE_OAUTH_TOKEN_URL?.trim() ?? "",
    clientId: process.env.CLAUDE_OAUTH_CLIENT_ID?.trim() ?? "",
  },

  claudeBin: process.env.CLAUDE_BIN?.trim() || "claude",

  agentIds: agentIds(),

  /** 直接注入 Cursor JWT；没有就读 `$XDG_CONFIG_HOME/cursor/auth.json` */
  cursorAuthToken: process.env.CURSOR_AUTH_TOKEN?.trim() ?? "",

  /** Antigravity 的订阅名（如 "Google AI Pro"）。配额接口不带它，只能人工指定；空 = 不渲染套餐 */
  antigravityPlanLabel: process.env.ANTIGRAVITY_PLAN_LABEL?.trim() ?? "",

  /**
   * Google OAuth 客户端。配了就直接用；都空就从 `agy` 二进制里扫候选，刷新时逐对试
   * （见 providers/antigravity-oauth-client.ts）。这两个值不要写进仓库。
   */
  antigravityOAuth: {
    clientId: process.env.ANTIGRAVITY_OAUTH_CLIENT_ID?.trim() ?? "",
    clientSecret: process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET?.trim() ?? "",
  },

  /** 扫 OAuth 客户端常量用的 `agy` 二进制；镜像里在 /usr/local/bin，别处跑可改 */
  agyBin: process.env.AGY_BIN?.trim() || "agy",

  /**
   * 凭据 home。镜像里固定 HOME=/data。Grok 另认 `GROK_HOME`，Codex 另认 `CODEX_HOME`。
   * 单测 / DRY_RUN 可以另指。
   */
  home: process.env.HOME?.trim() || "/data",

  /**
   * `{ "<id>": <该家原始 HTTP 响应体> }`。有这份就不出网、不读凭据，走各家规整函数。
   */
  limitsFixture: process.env.LIMITS_FIXTURE?.trim() ?? "",
} as const;
