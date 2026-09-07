# Worker 数据后端与首屏缓存

Worker 是唯一数据后端。上报、状态 API、Apple / GitHub 获取和缓存、WebSocket、在线人数均在 Cloudflare。Vercel 只在生成或后台重建首页时 GET `/api/home`；浏览器挂载后直接请求 Worker，不存在 Vercel 状态代理。

## 数据及权限

- `StateHub` 使用 SQLite Durable Object，`entries`、`fields`、`samples` 分别保存快照、字段和历史。SQLite 是唯一持久状态，DO 重启不丢数据。
- 上报读改写按对象队列串行执行；每次公开查询和上报有独立工作副本。存储批次由同步事务提交。返回 202 前已确认写入，失败不能成功应答。
- TTL 读取时检查，闹钟每小时分批回收过期项；导入保留原始绝对过期时间，重试不覆盖目标已有值。
- `/api/status/*`、`/api/home`、`/api/lyrics`、`/api/motion-artwork` 只输出明确的公开模型。没有 HTTP 通用数据库读写端点，服务端凭据不进入 Vercel、HTML 或状态响应。CORS 限制浏览器来源；公开 API 不以 CORS 当作秘密鉴权。
- `/api/ingest/*` 使用 `TELEMETRY_INGEST_SECRET`。临时 `/api/internal/storage/import` 使用独立 `STATE_IMPORT_SECRET`，不授予 Vercel，迁移后删除 Secret。
- `LIVE_PUSH` 使用可休眠 WebSocket，`ONLINE_COUNTER` 维护可见连接并按空闲超时清扫；`/count` 同时返回两种人数。

## 首屏与浏览器

`cachedHomeSnapshot` 一次读取公开聚合快照；单个数据源不可用使用卡片降级信封。网络失败抛出错误，不用错误快照覆盖已有 Next 缓存。Next cacheLife 为 stale 300、revalidate 600、expire 604800 秒；所有状态标签使用 `page:` 前缀。

Worker 写入完成后，只有展示变化才 POST `/api/revalidate`。接口校验 Bearer 和标签白名单，调用 `revalidateTag(tag, "max")`，已有 HTML 优先返回并后台重建。不使用 `expire: 0`，不因纯心跳刷新首页。浏览器查询直接访问 Worker，时间相关的新鲜度每次读取现算。

## 配置

Vercel 参照根 `.env.example`，仅公开后端源、缓存通知鉴权和图片配置。Worker 参照 `workers/api/.dev.vars.example` 与 wrangler.toml；GitHub Token 使用 Worker Secret，Apple Music 凭据来自 Mac 上报。`NEXT_PUBLIC_BACKEND_URL` 构建期写入前端，改值需要重新部署。

迁移后从 Vercel 移除 `GITHUB_TOKEN`、`REDIS_URL`、R2 写入凭据及旧推送地址；保留 `TELEMETRY_INGEST_SECRET` 用于缓存通知。环境变量删除不影响已有部署的环境快照，必须在清理后通过 Git 生成新部署。删除项目变量不等于撤销原始凭据，源 Redis 可在回退观察期继续保留。

## 验证与发布

1. `pnpm test`、`pnpm typecheck`、`pnpm exec tsc --noEmit -p workers/api/tsconfig.json`。
2. `node scripts/verify-api-worker.mjs` 启动隔离 SQLite 和模拟缓存通知服务器，验证鉴权、CORS、直接查询、WebSocket、心跳无失效、并发合并及重启持久化。
3. `NEXT_PUBLIC_BACKEND_URL=<测试 Worker 源> pnpm build`；在小号仓库和小号 Vercel 验证静态首页、缓存后台刷新以及浏览器网络路径。
4. 测试 Worker 用 `wrangler.test.toml`，独立对象命名空间，无生产域名或 cron。fork 的生产 Worker workflow 有仓库身份限制。
5. 测试通过后才合并主分支。生产采用 Git 自动部署，不手动发布 Vercel。腾讯云 EdgeOne 已退役，站点统一使用 Vercel。

## 生产导入顺序

新 StateHub 未初始化时拒绝上报和查询（503），避免空库被当成有效状态。保留源 Redis，暂停旧写侧后等待在途请求完成，运行 `scripts/migrate-state-storage.mjs --export <私有文件>`。导出文件含凭据，权限为 0600，不提交、不输出值。

给目标 Worker 临时设置独立 `STATE_IMPORT_SECRET`，配置 `STATE_SERVICE_URL`、`STORAGE_PREFIX` 后运行 `--import <私有文件>`，分批幂等导入、最后标记初始化完成。空的独立测试环境可用 `--initialize`。验证历史、新上报、实时响应和 HTML 后，移除导入密钥并清理临时文件。

部署前保留旧版本和源 Redis 作为回退点。切换失败时回退 Worker 和 Vercel 到同一套旧版本；测试阶段不触碰源数据或生产路由。迁移过程需覆盖从暂停写入到激活新对象的短暂重试窗口。
