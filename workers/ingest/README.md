# @lyjwpage/ingest

上报入口 + 实时推送，一个 Worker。前身是只管推送的 `live-push`。

上报器把信封 POST 到 `/api/ingest/<来源>`（路径和站点从前那几条一字不差，上报器只换源），
这里鉴权、写 Redis、直接在 Durable Object 房间里广播给连在 `/ws` 上的浏览器，再回敲站点的
`/api/revalidate` 让 `'use cache'` 过期。站点（Vercel 那份）因此只剩读路径。

落库和推送用的是站点 `src/lib` 里**同一批 store**，不是抄一份：wrangler 打包时按根目录
`tsconfig.json` 的 `paths` 直接把 `../../src/lib` 打进来，只用 `[alias]` 换掉三处依赖运行
平台的模块（见 `wrangler.toml`）：

| 站点那份 | 这里换成 | 差别 |
| --- | --- | --- |
| `@/lib/redis-driver`（ioredis） | `src/redis-driver.ts` + `src/redis-client.ts` | `cloudflare:sockets` 上的 RESP2 客户端，只实现各 store 用到的十来个命令 |
| `@/lib/live-platform`（`revalidateTag` / `after()` / POST `/publish`） | `src/live-platform.ts` | 失效是 POST 站点 `/api/revalidate`；响应之后再跑是 `ctx.waitUntil`；推送直接进房间 |
| `@/lib/r2-assets`（S3 协议 HEAD） | `src/r2-assets.ts` | R2 绑定 `head()` |

其余配置照旧从 `process.env` 读（`nodejs_compat_populate_process_env` 把 vars 和 secret
填进去），所以 `HEARTBEAT_WINDOW_MS`、`CHARGER_PUSH_INTERVAL_MS` 这些和站点同名同义，
不配就用同一套默认值。

和隔壁 `online-counter` 分开：那个只数人头，谁连上谁断开就是全部输入；这个要接写入、
要鉴权、要转发任意负载。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/ingest/<来源>` | 上报入口。`Authorization: Bearer <TELEMETRY_INGEST_SECRET>`。来源：`mac` `iphone` `homepod` `emby` `playstation` `server` `agents`，含义见根目录 README 与 AGENTS.md |
| GET | `/ws` | 浏览器的 WebSocket 端点。按 `ALLOWED_ORIGINS` 校验来源 |
| POST | `/publish` | 站点发布一条事件。`Authorization: Bearer <LIVE_PUSH_SECRET>`。现在只剩「最近在听」那份站点自拉的列表走这条 |
| GET | `/count` | `{"connections": n}`，此刻**开着**本站的页面数。上报器调频用，不鉴权 |
| GET | `/` | 健康检查，返回当前连接数 |

### 上报入口

响应和站点 `lib/api` 的 `ingestRoute` 一致：收下即 `202 { ok: true, data }`，`data` 是各来源的
回执（Emby 的 `missingImages`、Mac 的 `desktopIconAvailable` 等）；报文不合法 `400`；密钥不对
`401`；**没配 `TELEMETRY_INGEST_SECRET` 一律 `503`** —— 站点那份不配就放行是给本地开发留的，
这里是公网上一个直写生产 Redis 的口子，没有那种场景。

落库、推送、失效、转发全在响应之后跑（`waitUntil`）。顺序仍是 lib/live-events 的 fanout
定的：写库和带数据的推送并行；失效**等写完**再 POST 站点；只发通知的 `presence` 排在失效
之后。失效是整条路上唯一一次回到站点的 HTTP，失败只记日志 —— 数据已经在 Redis 里，缓存
最多旧到 `cacheLife` 兜底的 10 分钟。

回执里「有没有这张图」由这里用 R2 绑定直接回答。桶是两份部署共用的一个，所以答案对两边
都成立，不需要再并对端的回执。

### 转发对端

`INGEST_PEERS` 里的每个源都会收到一份原样的请求（同路径、同密钥、带 `x-ingest-relay`），
对端见到这个头就不再往下传。实现直接复用站点的 `lib/ingest-relay`。国内那份（EdgeOne）
接进来之前它仍然跑站点自己的 `/api/ingest/*`，所以这里填的是 `https://lyjw131.com`；
反过来 EdgeOne 的 `INGEST_PEERS` 要填这个 Worker 的源，让它收到的上报也到 Vercel 这份 Redis。

### /count

**`server-reporter` 靠它定中间那一档**：那个上报器每轮收尾先问 online-counter 有没有**可见**
的页面（有就 30 秒一轮），没有就问这里还有没有**开着**的页面（有就 2 分钟一轮，没有才睡
10 分钟）。两个数是两个口径 —— 站点侧 `use-online-count` 在页面不可见时把连接整条关掉，
`use-live-events` 不关，所以后台标签页和锁了屏的手机只在这个数里。字段因此叫 `connections`
不叫 `online`。改路径或返回形状要同步改 `reporters/server-reporter`。

数人头时会跳过静默超过 5 分钟的连接：对端消失却没发过 close 帧的连接会一直挂在列表里，
一条这样的僵尸就足以把上报器永远钉在中档。判据是运行时替我们记的 ping 自动回复时刻
（浏览器每 30 秒发一个），阈值取 5 分钟而不是贴着心跳画线 —— 后台标签页的定时器会被浏览器
节流到最多每分钟一响。「不计数」和「关掉」是两条线：锁屏、移动端后台会被整个冻结，随时会
解冻回来，关掉只会逼它重连。所以关的那条线推到 30 分钟，顺路在数人头时做掉，不额外挂闹钟。

### /publish

请求体就是站点那份 `LiveEvent`：

```json
{ "type": "listening", "payload": { "...": "..." } }
```

只校验 `type` 是非空字符串，`payload` 原样转发。响应 `{ "ok": true, "delivered": <收到的连接数> }`。

## 部署

1. 推 main 且 Worker、共享 `src/lib` 或根依赖有改动时 CI 自动 `wrangler deploy`（见 .github/workflows/deploy-workers.yml），手动
   `pnpm --filter @lyjwpage/ingest run deploy` 也行。域名路由在 `wrangler.toml` 的 `routes` 里，
   自定义域会自动建 DNS。**没配下面的 secret 之前它是安全的**：上报入口和 `/publish` 一律 503。
2. 存 secret（值要和 Vercel 那份站点的同名变量一致）：

   ```bash
   pnpm --filter @lyjwpage/ingest exec wrangler secret put REDIS_URL
   pnpm --filter @lyjwpage/ingest exec wrangler secret put TELEMETRY_INGEST_SECRET
   pnpm --filter @lyjwpage/ingest exec wrangler secret put LIVE_PUSH_SECRET
   ```

3. 先部署并配齐 Worker 的三个 secret，验证 Redis、R2 与 `/ws` 可用。
4. Vercel Production 把 `NEXT_PUBLIC_LIVE_PUSH_URL` 改为 `https://ingest.homepage.lyjw.llc`，
   提交并推 main。`next.config.ts` 只在 Vercel 上生成 `/api/ingest/:path*` 的外部 rewrite，
   在匹配 Next 路由前交给 Worker；上报器和 EdgeOne 仍可向 `https://lyjw.me/api/ingest/*`
   发请求，路径、Bearer 和单跳标记原样保留。浏览器同时切到新 Worker 的房间。
5. 验证 Vercel 的上报实际到达 Worker、Redis 已更新、缓存失效与 WebSocket 推送均正常。
   EdgeOne 的入口、环境变量及国内推送房间保持原配置；后续单独迁移国内侧。

上报器应直接使用 Worker 的源。Mac Telemetry Hub 在「设置 → 远端上报」中将上报端点
配置为 `https://ingest.homepage.lyjw.llc/api/ingest/mac`，保存后立即生效，Bearer 沿用原值。
所有上报器的生产目的地统一使用该 Worker，具体路径见根目录 README 的上报入口清单。
Vercel rewrite 仅保留给国内侧尚未迁移的中继流量。
`live.homepage.lyjw.llc` 也绑定到 ingest，和新域名进入同一房间；上报器原有的
`LIVE_PUSH_URL` 继续获得同一个 `/count`。完成验证后可删除旧 `live-push` Worker，
其旧 WebSocket 断开后会按原地址重连到新房间；国内推送服务不在本次变更内。

## 环境变量

`wrangler.toml` 的 `[vars]`（公开配置，入库）：

- `ALLOWED_ORIGINS`：`/ws` 的来源白名单，逗号分隔，支持 `https://*.vercel.app` 后缀通配。
  **留空 = 不限来源**（只为 `wrangler dev` 留的；localhost 始终放行）。配上之后不带
  `Origin` 头的请求一律拒绝。名单和 `online-counter` / `musickit-token` 是同一份。
- `REDIS_PREFIX`、`R2_PUBLIC_BASE_URL`、`EMBY_PUBLIC_URL`：和 Vercel 那份站点同值。写进
  Redis 的键、事件里拼出来的图片和 Emby 地址，读的那侧拿的是同一套。
- `SITE_URL`：处理完一次上报后回敲哪份站点的 `/api/revalidate`。
- `INGEST_PEERS`：对端部署的源，逗号分隔。留空不转发。

secret（`wrangler secret put`）：

- `REDIS_URL`：Vercel 那份站点读的同一个 Redis。`redis://` 明文或 `rediss://` TLS 都认。
- `TELEMETRY_INGEST_SECRET`：上报器 / 对端转发的 Bearer，也是回敲站点 `/api/revalidate` 的凭据。
- `LIVE_PUSH_SECRET`：站点 POST `/publish` 的 Bearer。

## 本地开发

```bash
pnpm --filter @lyjwpage/ingest dev          # wrangler dev，默认 8787
pnpm --filter @lyjwpage/ingest typecheck
pnpm --filter @lyjwpage/ingest test         # RESP 编解码
pnpm build && node scripts/verify-ingest-worker.mjs # 仓库根目录；需要 redis-server
```

`.dev.vars`（不入库）里填上面三个 secret 和要覆盖的 vars。联调站点时把 `SITE_URL` 指到
`http://localhost:3211`、`INGEST_PEERS` 留空、`REDIS_PREFIX` 换一个测试前缀，两边同前缀就能
从站点读到 Worker 写进去的东西，又不碰生产的键。`wrangler dev` 本机的 `cloudflare:sockets`
也能直连 Redis，不需要 `--remote`。

## 休眠

连接走 `ctx.acceptWebSocket()` 而不是 `ws.accept()`：这些连接绝大多数时间空转（上报器几十秒
才来一条），休眠之后实例可以被回收、连接照样挂着。心跳用 `setWebSocketAutoResponse` 由运行时
直接回，不唤醒实例。

代价是**不能把连接存在实例字段里** —— 休眠会清掉内存，醒来时构造函数重跑，那个 Set 就空了。
连接列表一律现问 `ctx.getWebSockets()`。同一条理由的反面：`setWebSocketAutoResponse`
**必须登记在构造函数里**，不能挪回 `/ws` 那条接入路径上。醒来那一次没有人走接入路径，
登记就丢了；此后的 ping 落到空的 `webSocketMessage`，自动回复时间戳不再走动 —— 而
`connectionCount` 正是拿那个时刻判活的。
