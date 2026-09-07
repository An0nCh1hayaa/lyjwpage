# API 中枢

所有上报器直连此 Worker。它负责鉴权、解析、写 SQLite、广播 WebSocket 和通知 Vercel 缓存失效。
站点没有上报路由、rewrite、中继和事件发布逻辑。站点部署在 Vercel，腾讯云 EdgeOne 已退役。

## 代码职责

- `src/index.ts`：七个上报来源、两条 WebSocket 接入、人头数、定时刷新。
- `src/online-counter.ts`：「此刻在线」的房间，只数可见的页面，人数一变就广播给房间里所有连接。
- `src/stores/`：上报解析与状态写入；`src/phone-telemetry.ts`、`src/homepod-ingest.ts` 组合设备信封。
- `src/fanout.ts`：先确认写入成功，再后台广播和通知首屏 stale。
- `src/apple-music-recent.ts`：最近在听的拉取、写入和广播。
- 根目录 `shared/`：读写共用的 SQLite 键、类型和状态计算；根目录 `src/lib/` 提供读取与通用工具。
- `src/storage-driver.ts`：通过 alias 接入 StateHub 的 SQLite 存储驱动。
- `src/r2-assets.ts`：R2 绑定 HEAD 检查，上报器仍直接上传图片。

## 端点

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/ingest/<来源>` | `mac`、`iphone`、`homepod`、`emby`、`playstation`、`server`、`agents` |
| GET | `/ws` | 浏览器接收事件推送的 WebSocket，页面开着就一直挂着；使用 `ALLOWED_ORIGINS` 校验来源 |
| GET | `/online/ws` | 「此刻在线」的 WebSocket，页面不可见时站点整条关掉；同一份来源白名单 |
| GET | `/count` | `{ ok, connections, online }`：开着的页面数与此刻可见的页面数，供上报器调频 |
| GET | `/` | 一行存活；不碰 Durable Object，根路径被探针不停打 |

两个数是两个口径，也是两个 Durable Object：`LivePushRoom` 走休眠 API，静默 5 分钟不计数、
30 分钟才关，因为后台标签页的定时器会被浏览器节流；`OnlineCounterRoom` 把连接留在实例里，
静默三个心跳周期（90 秒）就踢，因为可见页面不会被节流，一条僵尸多活 5 分钟就把三个上报器
多钉在快档 5 分钟。心跳 30 秒定义在站点 `src/hooks/use-online-count.ts`，Worker 里那份是
手抄的副本，改一边必须改另一边。`/online/ws` 不触发最近在听刷新：它按可见性反复重连。

上报要求 `Authorization: Bearer <TELEMETRY_INGEST_SECRET>`，未配置密钥或 SQLite 返回 503，
鉴权失败返回 401，非法报文返回 400，成功返回 202。202 表示持久化完成，广播和缓存通知由 `waitUntil` 执行。
旧站点 `/api/ingest/*` 与 Worker `/publish` 均不存在。

Worker 在 SQLite 写入完成后，仅对展示变化 POST `${SITE_URL}/api/revalidate`，使用同一 Bearer，只传 `{ tags }`。Vercel 按白名单将 `page:<tag>` 标 stale，先返回已有 HTML，后台重建。纯心跳不通知失效。

公开 API 为 `/api/status/*`、`/api/home`、`/api/lyrics`、`/api/motion-artwork`。浏览器挂载后直接访问这里，Vercel 只在首屏生成或重建时读取 `/api/home`。服务端凭据不进入任何公开响应，没有通用 HTTP 数据库端点。

## 最近在听

WebSocket 连接成功时检查一次。cron 每分钟检查连接数，有存活连接才刷新；无人连接时不拉 Apple。
SQLite `SET NX PX` 闸门与实例节流将真正的拉取限制为至少两分钟一次。
Mac 上报的 Apple Music 凭据保存在 SQLite，Worker 读取使用，不向外提供凭据端点。
状态读取不再触发拉取或广播。

## 配置与部署

`wrangler.toml` 中配置公开变量 `SITE_URL`、`STORAGE_PREFIX`、`R2_PUBLIC_BASE_URL`、
`EMBY_PUBLIC_URL`、`APPLE_MUSIC_STOREFRONT`、`ALLOWED_ORIGINS`，`IMAGES` 桶绑定，
以及 `LIVE_PUSH` / `ONLINE_COUNTER` 加 `STATE` 三个 Durable Object 绑定（迁移只追加新 tag，不改旧的）。
状态和凭据只存于 Worker 的 StateHub，Vercel 不连接数据库。秘密通过以下命令配置：

```sh
pnpm --dir workers/api exec wrangler secret put GITHUB_TOKEN
pnpm --dir workers/api exec wrangler secret put TELEMETRY_INGEST_SECRET
```

站点配置 `NEXT_PUBLIC_BACKEND_URL=https://api.homepage.lyjw.llc` 与相同的
`TELEMETRY_INGEST_SECRET`；浏览器由这一个源拼 `/ws` 和 `/online/ws`。所有上报器的目标为
这个 Worker 的 `/api/ingest/<来源>`，不经过站点，调频读的也是同一个源的 `/count`。实例清单见 [端点核验记录](../../docs/reporter-endpoints.md)。

提交并推送 main，由 `.github/workflows/deploy-workers.yml` 自动部署。
`shared/`、共用 `src/lib/`、根依赖及路径配置变化也触发 api 部署。

## 验证

```sh
pnpm --dir workers/api typecheck
pnpm --dir workers/api test
pnpm build
node scripts/verify-api-worker.mjs
```

集成脚本启动隔离 SQLite、Worker 和缓存通知测试服务器，检查鉴权、404、写入、缓存失效、两条真实 WebSocket
和 `/count` 的两个数，退出时清理临时状态。不要在本地开发配置中使用生产 SQLite。

SQLite 初始化、迁移与权限见 [后端架构](../../docs/state-storage.md)。

## Worker 更名

生产服务为 `api`，域名 `api.homepage.lyjw.llc`。`v1-transfer-from-ingest` 将旧 Worker 的三个 SQLite Durable Object 命名空间整体转移，保持 ID 与数据不变；后续部署保留这条迁移记录。不要对这些类另加创建或删除迁移。
