# ingest

所有上报器直连此 Worker。它负责鉴权、解析、写 Redis、广播 WebSocket 和通知 Vercel 缓存失效。
站点没有上报路由、rewrite、中继和事件发布逻辑。当前只覆盖 Vercel，国内侧另行设计。

## 代码职责

- `src/index.ts`：七个上报来源、两条 WebSocket 接入、人头数、定时刷新。
- `src/online-counter.ts`：「此刻在线」的房间，只数可见的页面，人数一变就广播给房间里所有连接。
- `src/stores/`：上报解析与状态写入；`src/phone-telemetry.ts`、`src/homepod-ingest.ts` 组合设备信封。
- `src/fanout.ts`：写入与完整数据广播并行；写完后失效缓存，再发送要求浏览器回源的通知。
- `src/apple-music-recent.ts`：最近在听的拉取、写入和广播。
- 根目录 `shared/`：读写共用的 Redis 键、类型和状态计算；根目录 `src/lib/` 提供读取与通用工具。
- `src/redis-driver.ts`：每个请求独立的 Cloudflare Socket 连接，通过 alias 接入共用 Redis 工具。
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

上报要求 `Authorization: Bearer <TELEMETRY_INGEST_SECRET>`，未配置密钥或 Redis 返回 503，
鉴权失败返回 401，非法报文返回 400，成功返回 202。202 表示已接收，后台工作由 `waitUntil` 保证执行。
旧站点 `/api/ingest/*` 与 Worker `/publish` 均不存在。

Worker 在 Redis 写入完成后 POST `${SITE_URL}/api/revalidate`，使用同一 Bearer，
只传 `{ tags, urgentTags }`。站点核验 tag 白名单；普通 tag 后台刷新，urgent 让 API 立即失效，
首屏仍后台刷新。失败记录日志，站点缓存到期兜底。

## 最近在听

WebSocket 连接成功时检查一次。cron 每分钟检查连接数，有存活连接才刷新；无人连接时不拉 Apple。
Redis `SET NX PX` 闸门与实例节流将真正的拉取限制为至少两分钟一次。
Mac 上报的 Apple Music 凭据保存在 Redis，Worker 读取使用，不向外提供凭据端点。
状态读取不再触发拉取或广播。

## 配置与部署

`wrangler.toml` 中配置公开变量 `SITE_URL`、`REDIS_PREFIX`、`R2_PUBLIC_BASE_URL`、
`EMBY_PUBLIC_URL`、`APPLE_MUSIC_STOREFRONT`、`ALLOWED_ORIGINS`，`IMAGES` 桶绑定，
以及 `LIVE_PUSH` / `ONLINE_COUNTER` 两个 Durable Object 绑定（迁移只追加新 tag，不改旧的）。
Vercel 与 Worker 使用相同 Redis、键前缀和状态契约。秘密通过以下命令配置：

```sh
pnpm --dir workers/ingest exec wrangler secret put REDIS_URL
pnpm --dir workers/ingest exec wrangler secret put TELEMETRY_INGEST_SECRET
```

站点配置 `NEXT_PUBLIC_LIVE_PUSH_URL=https://ingest.homepage.lyjw.llc` 与相同的
`TELEMETRY_INGEST_SECRET`；浏览器由这一个源拼 `/ws` 和 `/online/ws`。所有上报器的目标为
这个 Worker 的 `/api/ingest/<来源>`，不经过站点，调频读的也是同一个源的 `/count`。实例清单见 [端点核验记录](../../docs/reporter-endpoints.md)；iPhone 地址由用户自行修改。

提交并推送 main，由 `.github/workflows/deploy-workers.yml` 自动部署。
`shared/`、共用 `src/lib/`、根依赖及路径配置变化也触发 ingest 部署。

## 验证

```sh
pnpm --dir workers/ingest typecheck
pnpm --dir workers/ingest test
pnpm build
node scripts/verify-ingest-worker.mjs
```

集成脚本启动隔离 Redis、Worker 和 Next，检查鉴权、404、写入、缓存失效、两条真实 WebSocket
和 `/count` 的两个数，退出时清理临时状态。不要在本地开发配置中使用生产 Redis。
