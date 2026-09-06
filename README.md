# lyjwpage

个人主页。信息展示 + 实时状态：**最近在看**（Emby）、**最近在听**（Apple Music）、**最近在玩**（PlayStation，点瓷砖展开该款奖杯明细）、**充电设备**（Anker Prime 160W 充电头 / A110G 充电宝）、**Vibe Coding**（Claude Code + Codex）、**活动圆环**（Apple Watch）、**落地节点**（Tokyo）。

## 技术栈

|      |                                                               |
| ---- | ------------------------------------------------------------- |
| 框架 | Next.js 16 App Router（Turbopack）                            |
| UI   | React 19 · Tailwind CSS v4（CSS-first，无 `tailwind.config`） |
| 动画 | `motion` · `@number-flow/react`（实时数字滚动）               |
| 数据 | Route Handlers 代理 + SWR 轮询 + 自建 Worker 推送             |
| 字体 | Geist Sans / Geist Mono（本地字体包，构建不依赖网络）         |

## 跑起来

```bash
pnpm install
```

```bash
cp .env.example .env.local
```

填好 `.env.local` 后：

```bash
pnpm dev
```

开发服务器固定使用 `http://localhost:3211`，避开已占用的 3210。

## 部署在哪

同一个仓库三份部署，各有各的 Redis：

| 域名 | 平台 | 环境 | 说明 |
| --- | --- | --- | --- |
| `lyjw.me` | Vercel | 生产 | 主站 |
| `lyjw131.com` | EdgeOne | 生产 | 国内 CDN |
| `dev.lyjw.me` | Vercel | 预览 | 跟 `dev` 分支，开着 Vercel Authentication |

分不清哪个是哪个时看响应头：Vercel 是 `server: Vercel`，EdgeOne 是 `Server: edgeone-pages`。

### Vercel 那份只读：写路径在 Worker 上

Vercel 那份站点**不再接上报**。上报、写 Redis、推给浏览器这条路整个搬到了
`workers/ingest`（前身是只管推送的 `live-push`）：上报器把信封 POST 到它的
`/api/ingest/<来源>`（路径和站点从前那几条一字不差，上报器只换源），它鉴权、写
Vercel 那份 Redis、直接在自己的 Durable Object 房间里广播、再回敲站点的
`POST /api/revalidate` 让 `'use cache'` 过期。落库和推送跑的是站点 `src/lib` 里**同一批
store**，wrangler 打包时只用 `alias` 换掉 Redis 连接、缓存失效与推送、R2 校验三个依赖
运行平台的模块 —— 见那边的 README。

```text
上报器 ──▶ ingest Worker ──▶ Vercel 的 Redis / 自己的房间 / POST lyjw.me/api/revalidate
                └─转发─▶ EdgeOne /api/ingest/* ──▶ 自己的 Redis / 自己的 live-push / 自己的 tag
```

`/api/revalidate` 只传 tag 名单（普通 + urgent，语义和 `lib/live-events` 的 fanout 一致），
不传数据 —— 数据早在 Redis 里了，下一次读自己会去拿。它是整条写路径上唯一一次回到站点的
HTTP，只接受 `lib/live-events` 里 `STATUS_TAGS` 名单内的 tag，鉴权沿用
`TELEMETRY_INGEST_SECRET`，没配密钥一律 503。从前也有过一个只传缓存失效的端点，删掉的
理由是那时数据本身还靠两边共用一个 Redis 才对得上；现在数据由 Worker 外部写入，tag
通知是唯一剩下的跨边界事件，理由成立了。

### 两份生产之间靠传播上报对齐

上报器统一直连 ingest Worker，而两份生产各有各的 Redis、各有各的推送房间、各有各的 Next
缓存。所以**收到上报的那份除了自己落库，还会把同一个请求原样转给对面**：对面进的是同一
条路径、同一个 handler，于是它写自己的 Redis、推自己的房间、刷自己的 tag —— 三件事都在它
自己那边发生，没有谁远程指挥谁。国内那份（EdgeOne）**目前仍跑站点自己的 `/api/ingest/*`**，
它接收 Worker 的单跳转发。旧的站点上报地址不再作为上报器的生产配置；
Vercel rewrite 暂时只为国内侧尚未迁移的中继保留。

```text
上报器 ──▶ ingest Worker ──▶ Vercel 的 Redis / 自己的房间 / POST lyjw.me/api/revalidate
                └─转发─▶ EdgeOne /api/ingest/* ──▶ 自己的 Redis / 自己的 live-push / 自己的 tag
```

两边各自填对面那个源（`INGEST_PEERS`：Worker 的 `wrangler.toml` 里填 `https://lyjw131.com`，
EdgeOne 那份保留 `https://lyjw.me`，由 Vercel 路由层交给 Worker；Vercel 的 Next 处理器不再接收上报），不在代码里写死谁转给谁。
这一份数据到齐了，**缓存却各刷各的**：`revalidateTag` 只失效本实例那份 `'use cache'`，Vercel
另接了一套共享存储所以在那边是全局的，EdgeOne 那份因此填 `STATUS_CACHE=false`，让
`src/app/api/status/` 下的状态端点一律直读 Redis —— 见下面「状态是怎么接的」。转发出去的请求带
`x-ingest-relay`，对端见到它就不再往下传 —— 两边互填对方，再传一次就成环了；三份
以上各自填齐其余几份，一跳照样到齐。实现在 `lib/ingest-relay.ts`，站点的 `ingestRoute` 和
Worker 的入口都挂着它，所以新加一个来源自动就带传播。

代价说清楚：转发是尽力而为，对端挂了只记一行日志，不把这次上报打成 4xx（数据在本地
已经落库了，回 4xx 只会让上报器把同一份再写一遍）。所以对端会漏掉那一次变化 ——
Emby 那份每 10 分钟兜底整推一次，能自己追上；Mac 那几份要等下一次内容变化。
「最近在听」不在这条路上：它没有上报方，两份生产各自去 Apple 拉、各自落自己的
Redis（见下面那节），本来就不需要谁转给谁 —— 这也是 Vercel 那份站点**仅剩的一处写入**，
它落库后走 Worker 的 `/publish` 推给浏览器。
另外两边的 `receivedAt` 是各自收到的时刻，差几百毫秒，充电头曲线的采样点因此不完全
对齐，那是各存各的历史，不影响读数。

Worker 使用 R2 绑定检查对象是否存在。Emby 的 `missingImages` 和 Mac 的
`desktopIconAvailable` 仍由共享处理器结合本侧映射生成；异步转发不等待对端回执。
两份 Redis 的映射可能短暂不同，补齐仍依赖后续上报。

上报入库与实时推送（`ingest`）、在线人数、MusicKit 令牌签发、PlayStation 状态上报各是
一个独立的 Cloudflare Worker（四个都在 `workers/` 下）。**推 main 时 CI 部署有改动的 Worker；共享 `src/lib` 或根依赖改变时也部署 ingest**
（见 `.github/workflows/deploy-workers.yml`；`wrangler.toml` 在库里，秘密走
`wrangler secret` 不进 CI）。
**推送房间一份生产一个** —— 上报传到对端之后对端也要推一次，两边连同一个房间的话每个
浏览器会收到两份一样的事件。Vercel 那份是 `ingest` 自带的房间，EdgeOne 那份仍是它自己的
`live-push`（`live.homepage.lyjw.top`）；其余几个没有写入方，仍然共用一组（令牌签发那个
把三份部署的域名一起写进 `ALLOWED_ORIGINS` 即可，见「跟着一起听」）。
**Worker 的地址一律走环境变量**，源码里不写死 —— 否则任何人 clone 这个仓库跑起来
都会去打这边的 Worker。

### Mac 上报与 Vercel 读取

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/architecture-dark.png">
  <img alt="Mac 直连 ingest Worker，Worker 写 Redis 并推送浏览器，Vercel 读取状态" src="docs/architecture-light.png">
</picture>

本图聚焦 Mac 上报链路：Mac 的远端上报端点直接配置为
`https://ingest.homepage.lyjw.llc/api/ingest/mac`。Worker 写 Redis、通过 `/ws` 推送浏览器，
并调用 Vercel 的 `/api/revalidate`；Vercel 从 Redis 读取状态，提供首屏和状态 API。
图片仍由 Mac 直传 R2。交互版是自包含的一页
[`docs/architecture.html`](docs/architecture.html)（GitHub 不渲染 HTML，克隆下来用浏览器打开），
节点上标着对应的源码位置，可按上报写入、页面读取、实时更新分别查看。
图由 `docs/architecture.json` 生成，改了拓扑两边一起改。

### 上报入口清单

生产上报统一使用 `https://ingest.homepage.lyjw.llc`，路径按数据来源区分。
配置变量仍名为 `SITE_URL` 的上报器也填这个 Worker 的源；`SITE_INGEST_URL`
如果非空会优先覆盖它，因此切换时必须一起核对。

| 上报器 | 路径 | 配置位置 |
| --- | --- | --- |
| Mac Telemetry Hub | `/api/ingest/mac` | 设置 → 远端上报 |
| iPhone Telemetry Hub | `/api/ingest/iphone` | 设置 → 上报地址 |
| Home Assistant / HomePod | `/api/ingest/homepod` | `rest_command.push_homepod_now_playing.url` |
| Emby 推送代理 | `/api/ingest/emby` | NAS `emby-proxy/.env` 的 `SITE_URL`，运行容器名 `homepage-reporter` |
| Agent 限额上报器 | `/api/ingest/agents` | NAS `agent-limits-reporter/.env` 的 `SITE_URL` |
| 服务器上报器 | `/api/ingest/server` | 日本节点 `/opt/lyjwpage/server-reporter/.env` 的 `SITE_URL` |
| PlayStation 上报 Worker | `/api/ingest/playstation` | `workers/playstation-reporter/wrangler.toml` 的 `SITE_URL` |

## 状态是怎么接的

所有凭据只存在于服务端，浏览器只看得到 `/api/status/*` 返回的规范化数据。这些路由共用 `src/lib/api.ts` 的信封：上游挂掉时返回 `{ ok: false, error }` 而不是 5xx，让某一路数据源离线不至于把整页 SWR 打成错误态。

`src/app/api/status/` 下每一条状态 GET 的快照都走 Next `'use cache'`（`lib/status-cache`），上报按 tag 失效，轮询命中时不再每次打 Redis——**除非那份部署把 `STATUS_CACHE` 填成 `false`，那时它们一律直读 Redis**（没有例外，加新端点时不用另行登记）。这个开关是给 EdgeOne 那份准备的：`revalidateTag` 只失效**本实例**那份缓存（Next 默认是每个进程各自的内存 LRU，Vercel 另接了一套共享存储所以在那边看起来是全局的），而 EdgeOne 跑的是原样的 Next（腾讯云 SCF，多实例），上报进来了 GET 也不翻新，只能等 10 分钟兜底——2026-08-16 两边并排量过（当时 revalidate 还是 60 秒），落后 12~45 秒。国内那份的 Redis 就在同一朵云上，多打几次不心疼。开关只管状态端点，首屏那份得冻着才能预渲染，所以关掉之后第一帧仍可能旧到 10 分钟，挂载后 SWR 一拉就是最新的。光给两份部署各配一个共享的 `cacheHandlers` 对不齐首屏：Next 给预渲染页发的是按 `STATUS_LIFE` 算出的 ISR 头（2026-09-06 从 lyjw131.com 实测 `s-maxage=600, stale-while-revalidate=604200, durable`），Vercel 改写成 `max-age=0` 自己管，EdgeOne 原样在边缘存 10 分钟，`revalidateTag` 打不到那一份；要对齐还得在上报扇出里清 EdgeOne 缓存，目前接受这 10 分钟（并排实测两边首屏都只旧 2～3 分钟）。状态端点的 CDN 故意 `Cache-Control: no-store`：最终响应里有存活、`?since=` 切片、`expiresInMs` 这类现算字段，不能冻在边缘。函数每次进；心跳那种不触发 tag 的戳记在 overlay 里现读一把小 key。充电头历史与 GitHub 热力图的游标、奖杯目录的 `?titleids=`（展开哪块瓷砖就只发那 1–2 款，整份目录未来是几百 KB）也都是缓存命中后在内存里切全量，不按参数分键——分了就是每个游标、每块瓷砖各占一份完整快照。

Redis TCP 连接按请求作用域租用：同一 Node 实例里的并发请求共用一条，最后一个请求和命令结束后主动断开。不能让 ioredis 永久单例留在 serverless 实例里——实例暂停时普通 idle timer 不会跑，旧部署和 Preview 会各留一条空闲连接。Preview 必须不配 Redis 或使用独立 `REDIS_URL`；`REDIS_PREFIX` 只隔离键，不隔离连接额度。

各路数据几乎全是**推进来**的，本站没有任何按钟轮询上游的东西。推送入口共用 `/api/ingest/<来源>` 这组路径和同一个 `TELEMETRY_INGEST_SECRET`：Vercel 那份由 `workers/ingest` 接（`lyjw.me/api/ingest/*` 在路由层转交，上报器统一直连 Worker），EdgeOne 那份暂时仍由站点 `src/app/api/ingest/` 下的路由接，两边跑的是 `src/lib` 里同一个 `record*`。状态落在 `lib/redis.ts` 的 mirrorKey 里（Redis 为主、进程内存为辅，没配 `REDIS_URL` 也能跑）。七个上报侧：Mac Telemetry Hub、iPhone Telemetry Hub、Home Assistant（HomePod）、Emby 推送代理、PlayStation 上报 Worker、VPS 上的 server-reporter、NAS 上的各 agent 限额上报器（`reporters/agent-limits-reporter`）。剩下那两路没有上报方（Apple Music 的「最近在听」、GitHub 贡献日历）由站点自己拉，见下一段。PlayStation 那个 Worker 的 `wrangler.toml` 里 `SITE_URL` 已经填成 ingest Worker，合并到 main 部署之后即开始真实上报；站点侧已经接好 `/api/ingest/playstation`、`/api/status/playing`、`/api/status/playing/now` 和 `/api/status/trophies`，Worker 的代码和部署说明在 `workers/playstation-reporter/`。它的 cron 每分钟看一眼[那两个人头数](#三个上报器共用一套三档)：有人正看着就 60 秒一轮完整 tick，页面只是开着 2 分钟一轮，一个页面都没开压回 15 分钟一轮，**每轮都发 presence** —— 内容没变也发，那一封就是心跳：站点照样落库刷新 `observedAt`，但不广播、也不急失效，只推一次普通 tag 让快照跟着走。断流判定因此在 `/api/status/playing/now` 出口每次请求现算（`PLAYSTATION_STALE_MS`，默认 50 分钟 = 闲时三轮加余量），超窗发降级信封：**Worker 死了是「不知道他在不在玩」，不是「他离线了」**，所以宁可让卡片收起「正在游玩」那一行，也不伪造一个 `online: false`。奖杯目录只在解锁指纹变化时才推，没有 `/now`，也不走实时推送。前两个是**设备级的遥测中心**：一台设备一个入口、一个信封、一个 `modules` 字典。上报器只跟一个源站说话，收到的那份会把请求原样转给对端部署，见[上面那节](#两份生产之间靠传播上报对齐)。

首屏 HTML 与状态 API 使用独立的 `page:<主题>` / `api:<主题>` 缓存标签和条目。
普通上报让两份都后台更新；播放、充电结构等 urgent 上报只让 API 立即失效，首屏仍先返回
旧 HTML、后台重建。首页保持 `revalidate: 10 分钟 / expire: 7 天`，挂载后由 SWR 和推送更新。
共享缓存函数必须显式传入 `page` 或 `api`，嵌套调用也要沿用同一 scope，避免 API 标签传播
到整页，使下一位访客被迫等待取数、封面和歌词重建。没有缓存或超过 7 天硬过期时仍需重建。

缓存回归用生产构建（`pnpm build` + `pnpm start --port 3212`）验证，开发模式不代表 ISR 行为。
构建和启动均需使用隔离配置：`REDIS_URL`、`INGEST_PEERS`、`NEXT_PUBLIC_LIVE_PUSH_URL`、
`LIVE_PUSH_SECRET` 置空，`STATUS_CACHE=true`，`TELEMETRY_INGEST_SECRET=local-status-cache-verification`；
其他上游凭据及 Worker 地址同样置空，避免测试访问线上服务。然后执行
`node scripts/verify-status-cache.mjs`。脚本只接受本机地址，检查实际构建产物没有 API 标签泄漏，
再验证 urgent 上报后第一次 HTML 返回旧值、第一次 API 返回新值，以及后台重建最终收敛。
测试数据只留在该测试进程的内存里。

站点会出网的有三处，都走 `src/lib/cache.ts`（带 TTL、in-flight 去重和 5 秒负缓存）：① 给此刻在播的曲子查一个可跳转的地址；② GitHub 贡献热力图（`lib/github-chart`，TTL 10 分钟）去 `api.github.com/graphql` 取日历；③ Apple Music 的「最近在听」列表（`lib/apple-music-recent`，TTL 2 分钟）。后两路没有上报方，只能自己拉。**核心原则：前端轮询多快，回源频率都不变**，由各自的 TTL 决定 —— 三处都是被访客的请求驱动的，没人看时一次都不出网，也没有任何定时器。值存 Redis（进程重启和多实例共享）；in-flight 去重始终在进程内，它挡的是同一进程的并发穿透，Redis 代劳不了。

### 推给浏览器 — 自建 Worker

状态落库之后由 `lib/live-events.ts` 的 fanout 推一条事件：在 `workers/ingest` 里它直接进 Durable Object 房间广播；站点自己还会写的那一路（「最近在听」列表）往 Worker 的 `/publish` POST 一条。浏览器直连那个 Worker 收推送（`hooks/use-live-events.ts` 把收到的写进 SWR 缓存，卡片照旧用 `useStatus` 读，不用管数据是推来的还是轮询来的）。**本站不持有任何长连接** —— 从前这里是一条自建的 SSE，但在 serverless 上每条 SSE 连接都钉死一个函数调用、到 maxDuration 被掐断再重连，全程计费。

长连接挂在 Cloudflare 的 Durable Object 上，一个全站房间：

| 方法 | 路径                  | 谁在用                                                    |
| ---- | --------------------- | --------------------------------------------------------- |
| POST | `/api/ingest/<来源>`  | 上报器。`Authorization: Bearer <TELEMETRY_INGEST_SECRET>`；落库、广播、回敲站点失效 |
| GET  | `/ws`                 | 浏览器。按 `ALLOWED_ORIGINS` 校验来源，支持后缀通配        |
| POST | `/publish`            | 站点。`Authorization: Bearer <LIVE_PUSH_SECRET>`          |

站点这侧只配一个 `NEXT_PUBLIC_LIVE_PUSH_URL`（Worker 的源）加一个 `LIVE_PUSH_SECRET`，两条路径写在代码里 —— 它们和事件名一样，本来就是站点和自己那个 Worker 之间的约定。EdgeOne 那份接的仍是它自己的 `live-push`（只有 `/ws` 和 `/publish`），同一个变量名。

这里从前走 Pusher 协议（云 Pusher，或自部署 [Sockudo](https://github.com/sockudo/sockudo)）。换掉的理由不是它不好用，而是这条链路上唯一还托在别人手里的一环：单条事件 10 KB 的上限就近在眼前（两张列表 4.4 KB / 2.8 KB），免费额度按连接数和消息数计，而在线人数那条已经在自己的 Worker 上跑着了（`workers/online-counter`）。两个 Worker 分开部署：那个只数人头，谁连上谁断开就是全部输入；这个要接站点的写入、要鉴权、要转发任意负载。

连接走休眠版的 `ctx.acceptWebSocket()`，心跳用 `setWebSocketAutoResponse` 由运行时直接回 —— 这些连接绝大多数时间空转（上报器几十秒才来一条），实例可以被回收、连接照样挂着。

推送上只跑「状态翻面」：换前台应用、换曲子、插拔充电头、上报器上下线、两张列表变了。滚动读数（功率曲线、token 用量）仍由卡片自己 30 秒一轮地取 —— 推它们等于把推送当轮询用。丢一条也不至于卡住页面，轮询是兜底。

事件名和 `/api/status/*` 的路径一一对应：**`X` 是列表，`X-now` 是此刻**。带不带数据分两类：

| 事件 | 形状 |
| --- | --- |
| `desktop` · `listening-now` · `watching-now` · `playing-now` · `charger` · `listening` · `watching` · `playing` | 带数据，浏览器直接写进 SWR 缓存 |
| `presence` | 只发失效通知（payload 为 `null`），浏览器自己回来取 |

**一律带数据。** 两张列表曾经只发失效通知，理由是「整份太大」——实测 4.4 KB 和 2.8 KB，而发通知之后浏览器照样把整份取回来，字节一点没省，反倒多出一次请求头、一次往返、一个函数调用和一次 Redis 读，**而且是按在线人头乘的**。（那时的天花板是 Pusher 单条 10 KB，只有两倍余量；现在是 Cloudflare 单条 WebSocket 消息 1 MiB。）

只有 `presence` 仍是失效通知：它翻的是「上报器还在不在」。亲口离线是布尔值，浏览器要重取 `declaredOffline`；超时那条拿 payload 里的 `lastSeenAt` 和 `heartbeatWindowMs` 自己就能翻，源站不再算 `stale`。窗口默认 5 分钟（约三倍心跳），可用 `HEARTBEAT_WINDOW_MS` 改。

充电头那条带状态但**不带历史点**，是另一回事：曲线是增量同步的，服务端不知道各客户端的游标，只能要么整份重发要么发空增量。列表是整份替换，没有游标这回事。

两张列表的轮询兜底因此放到了 5 分钟一轮 —— 即时性由推送负责，轮询只兜「推送整体停用」这一种情况。

### 最近在看 — Emby

**本站不向 Emby 发任何请求。** 站点将来要部署到 Vercel，那时它够不着局域网里的 Emby（`http://emby.local:8096`），所以续播列表、播放位置和海报全部由 NAS 上的推送代理送进来：

```text
POST /api/ingest/emby
Authorization: Bearer <TELEMETRY_INGEST_SECRET>
```

代理的代码、配置和部署方式在 `reporters/emby-reporter/`。请求体的三部分都可省略、各推各的：`resume`（续播列表，60 秒一轮、有变化才推）、`playing`（播放位置，缺席表示这次不谈、显式 `null` 表示确认没人在看了）、`images`（`{ imageKey, objectKey }`，代理直传 R2 之后回报的对象键，只带站点还没有的那些）。

**Emby 的播放通知也先发给代理，再由它转发过来。** Emby 后台那个 webhook 配置项加不了自定义请求头，直发站点就只能开一个不鉴权的入口 —— 这个路径从前就是那样直收 webhook 的，那条路已经删了，现在站点只剩 `TELEMETRY_INGEST_SECRET` 一种鉴权方式。Emby 侧该怎么填见代理的 README。

推送只在开始/暂停/继续/停止、以及代理发现**拖了进度条**时才来，中间没有消息。但每条都带着当时的播放位置和总时长，所以未暂停时按真实时间往前推算即可 —— 进度条不轮询也能走。这同时兼作兜底：推算位置超过总时长说明播完了而「停止」没收到（客户端崩了、网络断了），此时按已结束处理，不会一直挂着。

Emby 对拖动进度条不发任何通知，那部分只能查会话。查的人是代理不是站点：它在播时每 2 秒问一次 `/Sessions`，但只在位置偏离站点的推算值超过 1.5 秒时才推 —— 站点算得准的时候推它等于白花一次函数调用。

状态存在 Redis（`lib/emby-store.ts` 的 mirrorKey，Redis 为主、进程内存为辅），站点不再向 Emby 拉任何东西。读路径上 `/api/status/watching` 和 `/api/status/watching/now` 跟着 `STATUS_CACHE` 走，和别的状态接口同一套。前端契约没变，两条仍是分开的：前者跟着 60 秒的推送走，后者跟着播放事件走，合在一起的话慢的那半只能跟着快的那半一起被重取。

剧集自身的 `Primary` 图是剧照而不是海报，所以竖版海报优先取所属剧的 `SeriesPrimaryImageTag`。这个选择在代理那侧做 —— 字节是它下载的，挑哪张的逻辑跟着走才不会分家。

#### 图片

海报由 Emby 上报器一次压成 WebP，以 `<sha256>.webp` 直传 R2；站点只接收对象键，响应时再用当前部署的 `R2_PUBLIC_BASE_URL` 拼公开地址。所以同一次上报传播到两份部署之后，Vercel 可以直连 R2，EdgeOne 可以改走以 R2 为源站的 COS CDN。上报器传之前先 HEAD 问一次桶里有没有，所以桶被清空、换机器、重启都能自己发现要补传，不必等站点回执。地址即内容指纹，所以对象带 `max-age=31536000, immutable`，浏览器直连交付域取图，站点没有图片读写或转码路径。

- **条目里存的是「图片键」而不是地址**（`imageKey`，由代理按 `itemId:kind:tag:height` 拼，图换了 ImageTag 键就换），读取时才换成地址。图片和列表是分两次推来的：列表先到、图片可能还在路上，或者 Redis 被清空后只需补图。晚到的那批图能把已经存着的列表一起点亮，不用整份重推。
- **响应里回 `missingImages`**：站点引用了却没有的键。代理据此补传，Redis 清空、容器换机器之后不需要人工干预。
- **上报器直传图片**：Emby 海报在代理侧用 sharp 压成 `<sha256>.webp`、Mac 图标用系统原生编码器压成 `<sha256>.png`，都由上报器直传 R2。站点只 HEAD 校验并保存对象键，公开 URL 在读取时按部署环境组装；Redis 里不存完整 URL 或任何图片二进制。HEAD 结果只缓存 5 分钟——桶被清空后站点要能重新发现对象没了，否则会一直发指向已删对象的 URL。

> 卡片的「在 Emby 里打开」跳转链接指向 `EMBY_PUBLIC_URL`，源站地址会出现在页面 HTML 里 —— 这是有意为之，不用改：Emby 前面有认证网关，跳过去的人会撞到认证。没配这个变量就不给链接，没有内网地址可退，退了也是个点不开的链接。

Apple Music 的封面没有代理，仍走 `mzstatic.com` 直链 —— 那本来就是公开 CDN，套一层反而多一跳。

### 最近在听 — Apple Music

列表由站点自己去 `/v1/me/recent/played` 拉（`lib/apple-music-recent`），拉回来存一个键、访客读那一个键。这件事在 NAS 上当过一阵常驻上报器，现在收编回来了。

**为什么当时要一个常驻进程。** 因为那时这份列表还兼着推断「此刻在不在听」：Apple 没有可查的当前播放接口，只能连续盯着列表里排第一的那项什么时候换人，再对照容器总时长猜它有没有播完。连续观测这件事在 serverless 上做不了——状态存在进程内存里，每个实例各有一份、活不到下一次切换。**那个推断已经撤掉了**，于是常驻的理由也没了。

**为什么撤掉它。** 它只在 Mac 和 HomePod 同时没声时才可能露面（有实况就以实况为准），而那正是它最没把握的时候：一直循环同一张专辑时第一项不变，会被当成已经停了；只听了一首就走开，仍按整张时长算，能一直显示在听；停下来但没换过东西的情况根本分辨不出来。卡片上那枚 `inferred` 角标就是在说「这一句我也不确定」。**现在「在不在播」只认设备实况**，这份列表只回答「听过什么」。

**于是刷新挂在访客的轮询上。** `/api/status/listening/now` 每个可见标签页 60 秒进一次函数，顺手在响应之后刷一遍列表（TTL 2 分钟，不新增任何函数调用）；没人看就一次都不拉，站点里没有任何定时器。第一个访客的首屏仍是手上那份，但他自己挂载后的第一次轮询当场就去拉，一两秒后由推送点亮——不必等一个上报器先反应过来把闲时那档提上去（从前最坏 15 分钟）。

TTL 定在分钟级不是为了「在听」的精度（那个已经没有了），是为了 hero 那条取色带：实时播放的封面配色是拿当前专辑 ID 去这份列表里借的，刚开播的那张要等它进了列表才有颜色可借。两分钟落在一首歌之内。

顺带纠正一个当时写在这儿的说法：闲时那 96 次/天**不是**在记录历史。站点每次都是整份替换、不累积，而 `/v1/me/recent/played` 本身就是 Apple 存着的历史，什么时候问都在。

需要 **Developer Token** 和 **Music-User-Token** 两条凭据，**全部由 Mac 上报器推来**：Mac Telemetry Hub 用本机 MusicKit 现签一对，作为 `appleMusicCredentials` 模块随 `/api/ingest/mac` 的信封送上来。`.p8` 私钥留在那台机器的钥匙串里由系统保管，服务器上一份都没有，本站也不含任何 JWT 签名代码。

MusicKit 签出来的 developer token 寿命约一个月（**Apple 没承诺这个数字**，实测在 29～30 天之间浮动过），上报器从它自己的 JWT 解出 `exp`，过了「上报时刻 → 到期时刻」的中点就重签重发。取相对中点而不是写死提前量，正是因为寿命不由 Apple 承诺，写死在两个方向上都可能错。实践中上报器重启比半个寿命周期频繁得多，所以多数情况是每次启动重传一份新的。站点这边只管收下最新的一份，不做提前判断——用的时候手上是哪份就用哪份，被 Apple 拒了就是这一轮作废。

凭据存 Redis，和 `telemetryState` 严格分开 —— 后者会经 `/api/status/*` 发到浏览器。那个 ingest 路由也不打印请求体。

**没有服务端自签的回落。** 有回落就意味着私钥仍得躺在服务器上，这套东西就白做了。代价是 Mac 上报器长期离线且 Redis 也丢了凭据时「最近在听」直接失败，这是明摆着的取舍。

**这份凭据也不从任何端点发出去。** 从前 `GET /api/ingest/apple-music` 把它转交给拉列表的上报器，代价是 `TELEMETRY_INGEST_SECRET` 从此和收听记录同等敏感（拿到密钥就能取走 token）；拉列表收回站点之后，那条路和那个代价一起没了。

拉的是 `/v1/me/recent/played?limit=10`。注意这个端点返回的是**专辑、歌单、电台这类容器**，不是单曲：专辑给 `artistName`、歌单给 `curatorName`，没有 `durationInMillis`，`limit` 上限是 10。时长要顺着容器的 `href` 再查一次曲目加起来（缓存 24 小时），封面对自建歌单还要去资料库副本取（缓存 12 小时，那是个 24 小时到期的预签名地址）——所以稳定状态下一轮刷新只有拉列表那一次真的出网。

刷新的闸门是 `lib/cache`：TTL 全站共享一份、in-flight 去重挡同一实例的并发穿透。**上游报错也盖同一个戳**——不然 5 秒负缓存一过值那半仍是空的，下一次请求又是一次真的上游调用，Apple 正病着的时候反而比正常快一个数量级。落库之后只在内容真的变了时才往浏览器推、才失效缓存，没变的那几轮什么都不做。

站点会打 Apple 的第二处（除了下面两节的动态封面和歌词，那两条走的是 amp-api）是「此刻在播的那首曲子」的跳转链接：Music.app 和 HomePod 都给不出可分享的链接，只能拿曲名 + 艺人现查目录，而这件事跟着当前播放走，和按固定节奏刷的列表不是一回事。命中缓存 7 天，绝大多数请求不会真的出网。要搬走该搬去 Mac 上报器——那边有 MusicKit，换歌那一刻就能把链接一起算好。两处共用 `lib/apple-music` 里的同一把凭据和同一个请求外壳。

### 跟着进度走的歌词 — amp-api

hero 上此刻在播的那首，副标题那一行会跟着进度条换成正在唱的那句；前奏、间奏、没有歌词的曲子和历史条目仍是艺人名。不另起一行：hero 的 80px 已经用掉 76px，两版 hero 的高度又必须一致。

**歌词只在 amp-api 上有，而且要两把钥匙一起。** 公开目录 API（`api.music.apple.com`）不给歌词；`amp-api.music.apple.com/v1/catalog/{sf}/songs/{id}/lyrics` 是网页播放器自己用的内部端点，`Authorization` 要的是从 `music.apple.com` 的 JS bundle 里扒出来的 web token（和动态封面同一份，扒取、Redis 共享、401 作废都在 `lib/apple-web-token`），订阅身份走 `Media-User-Token` —— 就是上面 Mac 上报器推来的那份凭据里的 music user token。缺后者时 amp-api 回的不是 401，而是和「这首歌没有歌词」**一模一样**的 404，所以「没有」只缓存一小时，有词的缓存 7 天；目录查询那一步顺手带回 `hasLyrics`，目录说没有的浏览器根本不问。

先要字级（`/syllable-lyrics`，`itunes:timing="Word"`，每个字一个带 begin/end 的 `<span>`），404 再退回行级（`/lyrics`）。字级那份的每句多一个 `words`，hero 上那一句按字从左到右点亮：每个字一个 span，`--sung` 是唱到了几成，CSS 把「已唱 / 未唱」两色渐变裁进文字（`.lyric-word`），播放中 rAF 每帧直接写 DOM，不走 React 重渲染。只有行级的歌整句一起亮。TTML 解析在 `lib/lyrics-ttml`（`<head>` 里的翻译不当成行，`x-bg` 和声整层丢掉，字间空格挂到前一个字后面所以 words 拼起来就是整句），哪句该亮在 `lib/lyrics-cue`，两个都是纯函数、都有测试。换句那一刻由一个定在边界上的闹钟驱动，不靠进度条那个整秒计时器；position 和进度条、字的点亮、「一起听」读的是 `lib/track-position` 同一份算法。响应 `no-store`，浏览器不留；同一页里 `hooks/use-lyrics` 按 songId 只问一次，模块级缓存兜着。

**`GET /api/lyrics` 不收参数，答的永远是此刻在播那首；动态封面（`GET /api/motion-artwork`）同样。** 从前两条都由浏览器传 songId / 链接来问，等于一个「任意 ID 换歌词 / 封面」的公开代理，歌词那条还得靠白名单挡。现在服务端读和 `/api/status/listening/now` 同一份快照、同一种取法（`lib/now-listening-read`，否则国内那份部署会「那边已是新歌、这边还是旧的」），自己决定取哪首；响应带 `songId` / `link` 让浏览器对号，对不上（两边快照短暂不一致）只挡 5 秒再问，并把答回来的那首先按它自己的身份存进缓存，推送把键翻过来时直接命中。URL 没有参数、内容随时间变，所以一律 `no-store`，浏览器和 CDN 都不存，结论缓存只剩 Redis 那层。歌词吐的是整首正文、拿我的订阅身份换来的，目录说 `hasLyrics` 为 false 的直接答空，不去问 Apple；浏览器那侧「没有」也只记一小时，和服务端同一个尺度。

### 跟着一起听 — MusicKit

卡片右上角那个「一起听」：访客用**自己的** Apple Music 订阅授权，MusicKit 在他自己那边放同一首、对到同一个进度。站点不转发任何音频 —— 传过去的只有一个目录 ID 和一个秒数，播放和计费都发生在访客和 Apple 之间。

**我的凭据碰不到这条路径。** 上面那份 Mac 推来的 token 带着 `Music-User-Token`，拿到就能读我的收听记录，所以它锁在 `TELEMETRY_INGEST_SECRET` 后面、只发给上报器。跟听要的是另一种东西：一份发给**任意访客**的 developer token，访客拿它去换自己的用户令牌。两者敏感度差一个量级，不共用一条路径，也不共用一把锁。

**签发放在 [workers/musickit-token](workers/musickit-token)。** 私钥不进站点的运行时 —— 站点部署在 Vercel，函数实例、构建日志、预览环境都能碰到那份环境变量；那个 Worker 只做一件事、只有一个出口、只吐一份有期限的令牌（默认 7 天，`TOKEN_TTL_SECONDS` 可改）。`.p8` 走 `wrangler secret`，Team ID 和 Key ID 不是秘密，放 `[vars]`。

**续期看半衰期**：过了「签发 → 到期」的中点就换一份新的，Worker 的缓存和站点的内存副本用的是同一条规则（两边都叫 `pastHalfLife`），所以响应里 `issuedAt` 和 `expiresAt` 一起给 —— 只给到期时刻的话，站点只能拿「我什么时候收到的」当起点，而收到的可能已经是 Worker 缓存着的、用掉一半的那份。取相对中点而不是写死提前量，和 Mac 上报器续自己那份 developer token 是同一个理由：写死的那个在两个方向上都可能错。

**域名限制是一份名单、两道闸**，都由 Worker 的 `ALLOWED_ORIGINS` 配：

| 闸 | 拦什么 | 谁校验 |
| --- | --- | --- |
| `Origin` 头比对 | 谁能来要令牌。配了名单之后不带这个头一律拒 | Worker |
| JWT 的 `origin` 声明 | 令牌只在这些域上有效，复制到别处就是废的 | Apple |

第一道只是让「拿一份」不那么随手 —— Origin 头是请求方自己写的，非浏览器伪造得了。**真正兜底的是第二道**，就是用 `.p8` 签的时候把允许的域写进 JWT。Apple 不解析通配符，所以 `https://*.vercel.app` 这类只参与第一道；通过之后签进声明的是**这次请求那个具体来源**，预览域名和 localhost 因此都能用，而声明始终是一串写死的完整来源。

**跟随由锚点变化驱动**，四件事：换歌重排队列并从对应进度起播；主人暂停跟着暂停；主人续播对齐再放；主人拖进度就地重新对齐。另挂一个 20 秒的慢速巡检，兜住访客那侧缓冲卡顿慢慢攒出来的偏差。差在 5 秒以内不动 —— 每次 `seek` 本身要重新缓冲，抖来抖去反而把差距拉大。

进度推算和 hero 的进度条**共用 `lib/track-position.ts` 一份算法**。两边各写一遍的话，页面上画到 1:23 而访客耳朵里在放 1:19，还没法一眼看出是谁错了。

点播要的是**曲目** ID，不是专辑 ID。目录查询本来就命中了那首曲子（为了拿链接），`hit.id` 顺手带出来就是，经 `TrackLookup.songId` 到 `NowListeningPayload.songId`。注意它和并排的 `id` 是两个东西：后者是所属的专辑 / 歌单，和 `/api/status/listening` 的 `items[].id` 对应。

两条明摆着的取舍：

- **换个国家可能就没这首。** `songId` 按站点的 `APPLE_MUSIC_STOREFRONT` 解出来，各地授权范围不一样，访客那边查无此曲时按钮翻成「重试」并说明原因，不静悄悄地什么都不放。
- **令牌 7 天到期。** 不取 Apple 允许的半年上限：它发给任何一个打开页面的人，域名限制之外就只剩有效期这一道闸。过了半衰期（3.5 天）再开始跟听会自动换一份新的，所以正常用不会碰到边界；但**同一个页面挂着不动、跟听中途跨过到期时刻，那一次播放会断** —— 已经配好的 MusicKit 实例不会中途换令牌。

不配 `NEXT_PUBLIC_MUSICKIT_TOKEN_URL` 则整个功能停用，右上角照旧显示「Apple Music」，卡片其余部分不受影响。

### 充电设备 — Anker Prime 160W 充电头 / A110G 充电宝

两台是同一个 `chargingDevices` 模块里的两项，靠 `kind` 区分，各自落库、各自推送；
只开其中一个模块是正常情况，列表里少一台不影响另一台。下面先说充电头，充电宝那半
在本节末尾。

数据来自 a2687-telemetry，它通过 BLE 读充电器、以 HTTP 暴露快照。`GET /status` 一次拿到整机功率 + 三个 USB-C 口的电压/电流/功率/协议/线缆/设备识别。

**本站不轮询充电头，只接收统一遥测推送。** Mac Telemetry Hub 从本机 a2687 服务读取 `/status`，把精简后的状态放进 v4 envelope，只 POST 到 `/api/ingest/mac`，并使用 `TELEMETRY_INGEST_SECRET` Bearer 鉴权。旧的 `/api/ingest/charger`、`/api/ingest/telemetry` 和 `/api/ingest/presence` 入口都已经删除，没有兼容路径，也没有本地轮询回退。

卡片**不主动**连本机端口。在这台 Mac 上打开 `/local/charging` 才会去连 `http://127.0.0.1:8787/sse/charger` 和 `/sse/powerbank`：端点往 localStorage 写一条记录再跳回首页，这台浏览器以后进站都会连。连上就改用这条约 1 Hz 的本机推流，不再用远端那份；连不上立刻放弃、不重试，远端照旧。

**总功率历史存在服务端**（`lib/charger-store.ts`，Redis；未配置 Redis 时退回进程内存）。客户端自己累积的话页面一刷新曲线就没了、还要攒很久才有形状。环形缓冲保留 400 点，两点之间至少间隔 `MIN_SAMPLE_GAP_MS`（当前 5 秒），足以覆盖固定 20 分钟图表窗口。

曲线的横坐标**按时间戳映射**而不是按序号等距铺开 —— 漏推一次就会有空档，等距会把那段画得和正常间隔一样宽。

超过 3 倍推送间隔（且至少 90 秒、也至少一个心跳窗口）没收到新数据就标记为断流，此时不再声称充电器在线，否则页面会一直显示旧的瓦数。「也至少一个心跳窗口」是必须的：安静时段没有新读数可发，续这条时间戳的就是那封纯心跳，窗口短于心跳间隔的话卡片会周期性闪回「未连接」。

几个上游的脾气：

- `connected`（BLE 链路）和 `mode`（某个口是否在输出）是两层状态，UI 要分开处理
- 上游把 `"N/A"` 当占位符大量返回，必须过滤，否则界面上会出现一堆 N/A
- `ports` 的 key 顺序不保证，必须按 key 取
- 设备名靠 (VID, PID) 查表，表是逐条实机观察积累的。查不到时显示 `Unknown`（口空着才显示 `—`）
- **没有温度字段，上游也不给历史** —— 曲线是本站自己攒的

**充电宝（A110G）** 走完全相同的来路：同一台 Mac 把 BLE 解出来的读数塞进
`chargingDevices`，本站按 `kind` 挑出来，落在 `lib/powerbank-store.ts`（Redis 为主、
进程内存兜底），读取走 `/api/status/powerbank`，卡片是 `components/live/powerbank-card.tsx`，
本机浏览时同样是打开 `/local/charging` 才直连 `/sse/powerbank`。收卡口径也和充电头一致：上报器离线、或者超过
`powerBankStaleAfterMs()` 没收到新推送，就把 `connected` 打成 `false`，浏览器不再自己算
一遍过期。那个窗口和充电头的 `chargerStaleAfterMs` 逐字对齐：默认 90 秒，但也不能短于
`CHARGER_PUSH_INTERVAL_MS` 的 3 倍、更不能短于心跳窗口（默认 300 秒）—— 安静时段没有新
读数可发，窗口比心跳间隔短的话卡片会周期性闪回「未连接」。

两处不一样：① **不存历史**。功率每帧都在跳、形状有信息，所以充电头那条曲线值得攒；
电量以小时为尺度变化，画出来几乎是条水平线，卡片上也就没画 —— 既然没人消费，采样间隔、
裁剪、TTL 那一整套就都不该存在。② 即时推送的触发条件是插拔、充放电切换、热控翻转和
整数电量跳格（外加插拔之后那段收敛窗口）；缓慢滚动的电量和功率仍然等卡片下一次轮询。

### Vibe Coding — 本地日志与云端用量

**用量**由 Mac Telemetry Hub 直接采集：Claude Code、Codex、Grok 等来源读取本地日志，
Cursor 的用量历史从账号云端获取；本地会话活动只用于判断“正在使用”，不能替代 Cursor 的
云端 token 历史。采集器按来源保存历史，再从同一份日数据生成累计、今日用量、模型排行和年度图。
**套餐与限额窗口**继续由 NAS 上的 `reporters/agent-limits-reporter` 走 `/api/ingest/agents`
独立上报；Mac 用量报文不带 `plan` / `limits` / `limitsError`。

Mac 信封保持这三个模块：

| 模块 | 间隔 | 内容 | 站点怎么处理 |
| --- | --- | --- | --- |
| `vibeCodingNow` | 60 秒 | 此刻是否活跃、当前模型、最近活动时刻 | 变了推 `vibecoding-now` 事件 |
| `vibeCodingUsage` | 10 分钟 | 各来源今日用量与采集状态，累计 token、API 等值费用、活动天数和会话数 | 保存摘要并失效首屏缓存，卡片轮询 |
| `vibeCodingYear` | 1 小时（可改） | 过去 53 周的日总量及每天前五模型 | 保存完整 371 天窗口；GET 和浏览器刷新都取整份 |

主要来源 id 为 `claude`、`codex`、`cursor`、`grok`、`antigravity`，采集器还可按相同契约增加来源。
每行 `today` 可以为 `null`，
表示尚未取得用量；成功采集的零用量仍用数字 `0`。每行必须带 `usageStatus`：

```text
{
  state: "ok" | "error" | "unavailable",
  collectedAt: ISO8601 | null,
  error: string | null,
  coverageStart: "YYYY-MM-DD" | null,
  coverageEnd: "YYYY-MM-DD" | null,
  precision: "measured" | "estimated" | "mixed",
  costComplete: boolean
}
```

`collectedAt` 是该来源最后成功采集时间；失败时保留旧时间、覆盖范围和已保存的历史，
只改变来源状态和错误。摘要顶层 `collectedAt` 是本轮摘要生成时间，不能拿它给失败来源续期。
日期统一按 `Asia/Shanghai` 分桶。`activeDays` 是所有来源已有历史中非零 token 日期的并集，
不是各来源天数相加，也不限定为热力图的 53 周。覆盖范围只代表原始来源当前能取得和已保存的历史，
不承诺云端提供永久全量历史。

`totals.costComplete` 为 `false` 时，`apiEquivalentCostUSD` 只汇总已知价格的部分；
费用完整性保留在数据契约中，页面不单独标记。未知模型的价格不能当成零费用。
来源采集状态和诊断信息保留在数据契约中。页面直接展示已有用量，缺值显示 `—`，
不附加采集、保存或估算提示；限额仍按自己的成功时间展示。

站点按 id 合并用量与限额，只有限额的来源也会显示。完全没有用量摘要时，status 的 `totals`、
`collectedAt` 和 `pushedAt` 为 `null`，页面显示“等待用量上报”，不伪造累计零值。
首页不展示 `opencode` 和 `pi` 来源行，API 和历史汇总仍保留这些数据。
网站只接收采集器准备好的摘要，不运行本地日志解析或 Cursor 云端认证。

年度图每次刷新完整窗口，云端补回或修正的旧日会直接替换浏览器已有格子。
`/api/status/vibecoding/year` 不再使用 `since`、`daysPartial` 或 `from`；GitHub 贡献图的增量机制不变。

切换采集器前应备份旧摘要与可导出的逐日历史，核对各来源 token、非零日期、会话数及费用覆盖；
本站 Redis 里的累计摘要和每日前五模型不能还原完整逐来源明细。新用量报文要求来源状态和费用完整性，
旧摘要不作为新协议读取，首份新摘要到达前仍可展示独立上报的限额。

本地端到端回归使用 `scripts/verify-coding-usage.mjs`。先启动连接独立 Redis 的开发站点，
显式设置测试用 `REDIS_PREFIX` 与 `TELEMETRY_INGEST_SECRET=local-token-usage-verification`，
关闭 peers / push，并暂停向该站点写入的上报器。保留默认状态缓存，验证覆盖实际缓存失效链路：

```sh
node scripts/verify-coding-usage.mjs \
  --redis-prefix token-usage-dev-20260905 \
  --snapshot /tmp/lyjw-usage-snapshot.json
```

默认只连接 `http://localhost:3211` 和 `redis://127.0.0.1:6389`，可分别用 `--base`、
`--redis-url` 指定其他本机测试地址；脚本拒绝非本机目标、默认 Redis 端口和未明确标识为测试的前缀，
不读取 `.env`。它验证鉴权、旧协议拒绝、仅有限额、未知用量与真实零、重复上报、独立 now 更新、
非法年度模块不部分写入、371 天整份刷新及旧日上调/下调。结束时恢复原有限额，并上报和读回
`--snapshot` 指定的 Mac CLI `{ usage, now, year }`；未传文件则留下合成基线。

### 各 agent 的限额 — 容器上报器

```text
POST /api/ingest/agents
```

请求体是 `{ collectedAt, agents: [{ id, plan, limits, limitsError }] }`，字段含义就是
`src/lib/types.ts` 里 `VibeCodingAgent` 上同名那几个。一封只带这次采集到的 agent，**没出现
的 id 站点不动**（按 id 合并进 `vibecoding:limits`）；某家没登录就不发那一行，登录了但取
不到就发空 `limits` 加 `limitsError`，页面据此把「没配」和「配了但取不到」分开。取失败时
不要把上一次的好值再发一遍，站点自己留着。

**每轮必发**，内容没变也发 —— 那一封就是心跳。站点给每行盖 `limitsAt`（收到的时刻），
采集采用[同款三档](#三个上报器共用一套三档)：可见 5 分钟、仅开着 10 分钟、无人 60 分钟。
站点把最慢档三轮加余量的窗口（`AGENT_LIMITS_STALE_MS`，默认 185 分钟）作为
`limitsStaleAfterMs` 一起发给浏览器，陈旧与否浏览器自己算：条照画、数字停在最后一次看到
的值，但整块淡掉并标 Stale。不在服务端拼「N 分钟没更新」—— 首屏是 `'use cache'` 冻住的。
这一路不走实时推送，卡片 30 秒一轮自己来问。

容器里各家 CLI 各登录一次，凭据落在自己的卷里，**不拷 Mac 的凭据** —— 两份 refresh token
各自刷新会互相作废。Claude / Codex / Grok Build 由上报器自己拿各家 CLI 的登录态打各家的用量
接口（直接读取官方 CLI 的登录态）；Cursor 和 Antigravity 的接口是抓 CLI
的 `/usage` 抓出来的，同样直打。五家的登录都在容器里做一次。部署、登录步骤和环境变量见
`reporters/agent-limits-reporter/README.md`。

卡片顶部汇总全量 token、API 等值费用和活跃天数，并按 input、output、cache read、
cache write 展示占比（信封里另有 reasoningTokens，尚未上屏）；下方展示 Claude Code 和 Codex 的今日 token、
缓存命中率、历史主力模型、套餐，以及统一的 5-hour limit 和 Weekly 两条。某一槽没有窗口
就显示 Unlimited。年度 token 热力图和 GitHub 贡献图合在联系卡里，用 Tokens / Commit
切换；格子悬停显示当天总量和前五模型。Cursor、Grok Build 和 Antigravity 同一份数据里也有
token 明细，首页只取用量最高的那一扇限额窗口画一条进度。最近活动时刻由会话摘要
提供，用于真实的“正在使用”状态。

费用是公开 API 价格的等值估算，只表示这些 token 如果走 API 的价格，不是
Claude/Codex 订阅账单。上报摘要不含提示词、回复、session ID、项目名或文件路径。

### 本机实时活动 — Mac Telemetry Hub

`a2687-telemetry/A2687TelemetryMac` 已从单一充电头工具扩展为可插拔的本机遥测中心。充电头、前台应用、本机 Apple Music、Mac 时区和 vibe coding 都能独立开启或关闭。Apple Music 通过 macOS Apple Events 读取 Music.app 的本机播放状态，与上面的 Apple Music API“最近在听”完全独立。

所有采集器统一写入：

```text
POST /api/ingest/mac
```

请求采用唯一的 `version: 4` envelope，顶层带 `heartbeatAt`、`presence`（`online` / `offline`）和 `activeModules`；模块名固定为 `chargingDevices`、`desktop`、`appleMusic`、`appleMusicCredentials`、`timezone`、`vibeCodingUsage`、`vibeCodingNow` 和 `vibeCodingYear`，`modules` 只携带发生变化的模块。`activeModules` 是**开关**清单（vibe coding 只有一个开关，写作 `vibeCoding`），和模块名不是一套东西。充电头和充电宝多一条：开关开着**还要那条 BLE 真连着**才会列出来 —— 别的模块的数据源和上报器在同一个进程里，信封发得出去就证明源还在；这两个的读数来自蓝牙那头，链路断了 App 照样发心跳。站点拿这份清单给充电头续期（`prepareHeartbeat`），所以清单不诚实的后果是：充电头断了好几天，`charger:lastPush` 还在被每轮刷新，`withChargerFreshness` 那条「多久没推就算断流」永远判不出来。**「连着但安静」仍然算 active** —— 那正是续期存在的理由，只有「没连上」才消失。前台应用图标始终带 SHA-256，二进制只在该哈希尚未被服务端保存时上传。

上面那些模块的指纹一个都没变时，发的是**空 `modules` 的信封**，也就是一次纯心跳：只刷新存活，不动任何模块的时间戳。心跳无变化时每 ≥30 秒一条，有数据要发时不补——那个包本身就证明上报器活着。这个间隔正在往 90 秒放宽（纯心跳是 `/api/ingest/mac` 的主要流量）：**站点这侧先把存活窗口放宽到 5 分钟，上报器再降频**，顺序反了会有一段时间全站断续显示离线。

从前心跳和优雅下线走独立的 `/api/ingest/presence`，于是「上报器还活着」这一件事在服务端有两个写入点。现在只有这一条路：`presence: "offline"` 覆盖退出、睡眠这类优雅离开，崩溃、断网、强制关机时上报器什么都发不出来，那些仍靠「多久没收到」的超时兜底（默认 5 分钟，约三倍心跳，可用 `HEARTBEAT_WINDOW_MS` 改），两者互补。窗口盖在 presence 的 `heartbeatWindowMs` 上，浏览器用这一份。存活本身单独存一个 Redis key（`lib/reporter-liveness`），不再搭遥测状态那份镜像的车——那样多实例部署时，没接过上报的实例手上永远是零，会把卡片全判成离线。

各模块的指纹粒度决定了「无变化」有多容易达成：`chargingDevices`（充电头和充电宝在同一个列表里）含功率/电压/电流，充电中几乎每轮都变；`desktop` 是应用名 + bundleID + 图标，不切应用就不变；`appleMusic` 的进度**不入签名**，所以播放中也不变，只有 seek 偏离锚点超过容差才算；`timezone` 只有 IANA 标识、当前 UTC 偏移或缩写变化时才重发；三个 vibe coding 模块各看自己那份载荷有没有变，`vibeCodingUsage` 带着采集时刻所以每轮必发，`vibeCodingNow` 在没动过键盘的那些轮次里一动不动。真正的零 telemetry 场景是充电头和充电宝都没动静（没在充也没在放）、不切前台应用、音乐不换曲不 seek、时区不变、vibe coding 采集器未刷新——此时只有每 30 秒一条空 `modules` 的心跳。

前台应用图标由 Mac 一次缩放成 96px PNG（系统原生编码，不依赖任何外部二进制）并直传 R2，网站只接收对象键 `<sha256>.png`、HEAD 确认后组出公开直链。**没有服务端接收图片二进制的回退**：`iconData` 一旦出现在信封里就直接报错。`iconHash` 标识「哪个应用的图标」（应用有图标就非空，编码或上传失败也照样有），对象键标识「哪份字节」，两者分开才能让站点回执区分「这个应用没图标」和「图标还没准备好」——从前它们是同一个哈希，编码一失败就静默丢图、永不重试。状态里只存公开直链，普通状态心跳不会重复携带图片。时区模块只上传 IANA 标识、当前偏移和缩写，不上传地址。时区只进首屏，没有 status 端点。公开读取按用途拆开，以 `src/app/api/status/` 下的目录为准：`/api/status/desktop`、`/api/status/charger`、`/api/status/powerbank`、`/api/status/listening`、`/api/status/listening/now`、`/api/status/watching`、`/api/status/watching/now`、`/api/status/playing`、`/api/status/playing/now`、`/api/status/trophies`、`/api/status/vibecoding`、`/api/status/vibecoding/year`、`/api/status/activity`、`/api/status/server`、`/api/status/github-chart`。活动圆环来自 iPhone Telemetry Hub（见下面那节），落地节点那条来自节点上的上报器（`reporters/server-reporter`），最后那条不由任何上报器喂，是站点自己去 GitHub GraphQL 取的（所以它是唯一不参与 tag 失效的一条 —— 同样自己拉的「最近在听」参与，因为它落库、有 tag、也推），其余都对应上面某个模块。

### HomePod mini 播放实况

Home Assistant 在 HomePod 换歌、切换 `playing / paused / idle / off`、进度跳变
（`media_position_updated_at`）或切换循环模式时，把媒体状态推到：

```text
POST /api/ingest/homepod
Authorization: Bearer <TELEMETRY_INGEST_SECRET>
```

进度跳变那条触发器不能少：单曲循环时曲名和播放状态都不变，只有进度归零，
少了它服务端就不知道这首又从头开始了。

接收端复用统一遥测密钥，状态写入 Redis（未配置时退回进程内存）。`/api/status/listening/now`
按「MacBook 在播 → MacBook 暂停未满 10 秒 → HomePod 在播 → HomePod 暂停未满 10 秒」
选来源。两个候选跟着 `STATUS_CACHE` 冻或不冻，选择和 `expiresInMs` 每次请求现算，
所以暂停宽限期到点再问能换到下一首，而不用等 Redis。事件带有进度观测时间，前端据此自己
推算进度。

这个宽限期是全站唯一一条「不靠新上报、光靠时间流逝就会改变结果」的规则，而那个
到期时刻不对应任何一次上报，没有推送会到。**服务端不为它挂定时器** —— 那要求进程
在响应发出之后还活着，serverless 上响应一返回实例就冻结，定时器根本不执行。改成
payload 带一个 `expiresInMs`，由浏览器把下一次取数排在到期那一刻。差值由服务端用
自己的时钟算：`observedAt` 是**设备**的时钟，让浏览器再拿**自己**的时钟去减，偏差
超过宽限期时浏览器会认定「早过期了」而服务端认为没有，退化成热轮询。

请求体的字段名和单位**和 Mac 上报器的 `appleMusic` 模块一致** —— 两个入口产出的
是同一个 `LocalNowPlaying`，同一个概念不该有两套叫法。所以毫秒就是毫秒、时间戳
就是 epoch 毫秒，HA 那边在模板里转好再发：

| 字段 | 类型 | 来源 |
| --- | --- | --- |
| `state` | `playing` / `buffering` / `paused` / 其它 | 实体状态，`buffering` 按播放中处理 |
| `title` / `artist` / `album` | 字符串 | `media_title` / `media_artist` / `media_album_name` |
| `entityId` | 字符串 | 实体 ID，和曲目信息一起哈希出 HomePod 侧的曲目身份 |
| `artworkUrl` | 字符串 | `entity_picture` |
| `positionMs` | 毫秒 | `media_position × 1000` |
| `durationMs` | 毫秒 | `media_duration × 1000` |
| `repeatOne` | 布尔 | `repeat == 'one'` |
| `observedAt` | epoch 毫秒 | `media_position_updated_at`，模板里 `as_timestamp() × 1000` |

判定“这条记录还算不算数”看的是**距上次收到推送多久**，不是推算进度有没有超过曲目
时长 —— Home Assistant 按状态变化推送，曲目放完到下一条推送之间必然超时，拿它当
作废依据会让播放中的曲目凭空消失。

推送来自两台 Home Assistant：`ssh dsm` 上的 `media_player.wo_shi`，以及
`ssh n100` 上的 `media_player.zhu_wo_lyjw`。两台都直连
`https://ingest.homepage.lyjw.llc/api/ingest/homepod`，使用相同契约。
当前核验与回滚记录见 [上报端点核验](docs/reporter-endpoints.md)。

`rest_command.push_homepod_now_playing` 的形状（`<E>` 换成对应实体）：

```yaml
url: "https://ingest.homepage.lyjw.llc/api/ingest/homepod"
method: post
content_type: "application/json"
headers:
  authorization: !secret telemetry_ingest_authorization
payload: >-
  {{
    {
      "entityId": "<E>",
      "state": states("<E>"),
      "title": state_attr("<E>", "media_title"),
      "artist": state_attr("<E>", "media_artist"),
      "album": state_attr("<E>", "media_album_name"),
      "artworkUrl": state_attr("<E>", "entity_picture"),
      "positionMs": ((state_attr("<E>", "media_position") | float(0)) * 1000) | round | int,
      "durationMs": ((state_attr("<E>", "media_duration") | float(0)) * 1000) | round | int,
      "repeatOne": state_attr("<E>", "repeat") == "one",
      "observedAt": (as_timestamp(state_attr("<E>", "media_position_updated_at"), as_timestamp(now())) * 1000) | round | int
    } | to_json
  }}
```

**先拼 Jinja 字典再整个 `| to_json`，别手写引号。** 手写 `"{{ ... }}"` 的话，曲名里
只要有一个 `"` 就拼出非法 JSON、整条推送 400；属性缺失还会渲染成字符串 `None`
而不是 `null`。`to_json` 两件事一起解决。

`observedAt` 的兜底值取 `now()` 而不是 `0`：HomePod 刚上线时
`media_position_updated_at` 可能还没有，落成 `0` 会被站点当成 1970 年的锚点，
进度条直接推算飞掉。

`secrets.yaml` 只保存完整 header 值，不把密钥写进配置或仓库：

```yaml
telemetry_ingest_authorization: "Bearer <TELEMETRY_INGEST_SECRET>"
```

`artworkUrl` 收的是 Home Assistant 的 `entity_picture`，那是一个带 `cache` 参数的代理地址。
接收端只提取其中公开的 Apple CDN URL，并把 `{w}`、`{h}`、`{f}` 占位符替换成
`600`、`600`、`jpg` 后交给前端；Home Assistant 的局域网地址和代理 token 不会公开。

### iPhone Telemetry Hub — 活动圆环

手机上的遥测中心，和 Mac 那个是同一个骨架：一个入口、一个信封、只带这次变了的模块。
源码在 `reporters/iphone-telemetry-hub`（SwiftUI，怎么装见那边的 README）。
眼下只有一个模块 —— 手表全天戴着，三环（活动 / 锻炼 / 站立）和当天步数：

```text
POST /api/ingest/iphone
Authorization: Bearer <TELEMETRY_INGEST_SECRET>
```

```json
{
  "version": 1,
  "modules": {
    "activity": {
      "date": "2026-08-24",
      "secondsFromGMT": 28800,
      "moveKcal": 69,
      "moveGoalKcal": 270,
      "exerciseMinutes": 1,
      "exerciseGoalMinutes": 30,
      "standHours": 2,
      "standGoalHours": 10,
      "steps": 719,
      "distanceMeters": 527,
      "flightsClimbed": 12
    }
  }
}
```

**端点按观测数据的那台设备命名**（AGENTS.md 第 1 条）。圆环其实是手表采的、Apple 健康
汇总的，但搬运和观测它的是这台 iPhone —— 和 `/api/ingest/mac` 一个道理：那边的充电头
数据出自 Anker 的充电器，照样走 `mac`。这条路一开始叫 `/api/ingest/apple-health`，
那时它是个只报健康的单一用途 App；改成遥测中心之后旧路由直接删了，不留兼容路径。

**骨架照抄 Mac，字段不照抄。** 那份信封还带 `heartbeatAt` / `presence` /
`activeModules`，这里一个都没有：它们在那边成立是因为 Mac 上跑的是常驻进程 ——
心跳能证明它还活着，`activeModules` 能让充电头在没有新读数时继续续命。iPhone 上这个
App 平时**根本不在运行**，是 HealthKit 有新数据时才把它拉起来。照搬那三个字段只会让
站点以为自己能判断手机在不在线，而它判不了。版本号也从 1 起，不接着 Mac 的 4：
两套协议各活各的，共用一个号只会让人以为改一边要跟着改另一边。

回执是 `{accepted, ignored}`。`ignored` 是收到了但站点不认识的模块名 —— 手机上装了
带新模块的版本、而站点还没部署时，唯一看得见这件事的地方就是它，否则表现是「那份数据
一直没出现」而两边都不报错。

| 字段 | 说明 |
| --- | --- |
| `date` | **手表本地**的那一天，YYYY-MM-DD。从 summary 自己的 `dateComponents` 推，不是另拿 `Date()` 算的 —— 午夜前后两者会差一天 |
| `secondsFromGMT` | 当前时区的 UTC 偏移，秒。和 Mac 时区模块同名同单位（AGENTS.md 第 4 条） |
| 三环六个数 | 已完成 + 目标。**目标是从 `HKActivitySummary` 读的真目标**，不是站点配的常量；必须为正，手表当天还没有 summary 时上报器整封不发 |
| `steps` / `distanceMeters` / `flightsClimbed` | 选填。取不到时整个字段不出现（站点存 `null`，卡片整格不渲染），和「今天是 0」分得开 |

一开始接的是 [Health Auto Export](https://apps.apple.com/app/id1115567069) 那个成熟的
第三方 App，换成自己写的只为一条：**它导不出三环的目标值**。它导的是 HealthKit 的样本，
而目标在 `HKActivitySummary` 里，只有原生 App 读得到 —— 于是目标只能配成站点这侧的环境
变量，手表上调一次就要改两份生产的配置，同一个数从此有两个来源。实测那三个目标是
270 / 30 / 10，和写死的缺省值 500 / 30 / 12 差得很远。

**每封都是当天的全量绝对值**，站点整份替换、后到的就是对的，没有「旧的不许盖新的」那道闸。
它和上报器那侧「失败了不补发」是一对：哪天给上报器加了后台重试队列，这里就得把顺序闸
一起加回来。按日期挡也不行 —— 往西飞过日界线时本地日会往回走一天，而手表上的圈确实跟着回去了。

**日期是手表本地的那一天，站点绝不自己算。** 圆环在手表所在时区的午夜归零，而源站的钟
在美国、访客的钟在任何地方。跨过午夜之后卡片把圈画淡、写明「X 月 X 日的记录」，而不是举着
昨天那份满环装作是今天的。这个判定**整个由源站在取数出口现算**（`currentAtSource`），
浏览器不自己算一遍：它手上没有一个会走的钟（`useMountedAt` 是挂载那一刻的定格），
拿它比日期的话，开着不动的标签页永远停在挂载那一天，跨夜之后新到的**今天**那份反而
会被判成「昨天的记录」—— 正好把这个判定用反。代价是跨过午夜后最多晚一轮轮询（5 分钟）
才翻，端点每次请求现算，所以轮询就是它的刷新节奏。

**这条链路上没有实时推送，卡片 5 分钟轮询一次。** 圈以分钟为尺度涨，为它开一路广播就是
拿推送当轮询用（和时区模块同一个判断：失效是白给的，广播才是按人头付钱的）。而且上报侧
的天花板在 HealthKit —— **后台投递按小时节流**（`HKObserverQuery` 传 `.immediate` 也会被钳到
`.hourly`），App 不在前台时最快也就一小时一份。5 分钟轮询已经是十几倍的过采样。

同样因为这个节流，这张卡**不跟任何「上报器在不在线」挂钩**：手机整夜不动就是没有新样本
可推，那时圈冻在最后一次推送上是正确的，不是掉线。状态灯只表达「最近 90 分钟有没有更新过」
—— 这个窗口是按上报侧那个小时级节流定的，留了半小时余量。

### 落地节点 — Tokyo

跑在日本落地节点上的上报器，读 `/proc` 把 CPU、内存、网速推过来。站点不 ssh、
不轮询那台机器。源码在 `reporters/server-reporter`（Python 3 标准库 + systemd，
怎么装见那边的 README）。

```text
POST /api/ingest/server
Authorization: Bearer <TELEMETRY_INGEST_SECRET>
```

路径按数据是谁产生的命名：数据是这台机器自己的，不是那个 `.py` 的。换个采集脚本，
这个 URL 也不该跟着改。`id`（SSH 配置里的 `misaka-jp`）和 `hostname` 分开留，卡片上
认的是人起的名字。

**每封都是心跳。** 上报器每轮都发，站点拿 `pushedAt` 判断它还活着没有。节奏是
和 PlayStation 那个 Worker 共用的那套三档（见[下一节](#三个上报器共用一套三档)）：有人正看着
60 秒、页面只是开着 2 分钟、一个页面都没开 15 分钟。断流窗口锚最慢那档，默认 50 分钟
（可用 `SERVER_STALE_MS` 改）。这条路上没有实时推送 —— CPU 和网速每个间隔都在变，
广播就是拿推送当轮询用；卡片 30 秒自己来问（和充电头一档，比快档还勤，多出来那趟拿到
同一份数字），上报只让首屏那份缓存失效。改的顺序和心跳窗口那条一样 —— 先放宽窗口
部署，再给上报器降频。

公开读取是 `/api/status/server`，没有 `/now`：一台机器一份快照，不配列表。

### 三个上报器共用一套三档

`server-reporter`、`playstation-reporter` 和 `agent-limits-reporter` 按相同人数口径分档，
限额使用更长间隔（`apple-music-reporter` 从前也在这套里，它已经退役，那份列表改由站点在
访客的请求里自己拉，见[上面那节](#最近在听--apple-music)）：

| 问到什么 | server / PlayStation | agent limits |
| --- | --- | --- |
| `online-counter` 的 `GET /count` 大于 0 —— 有页面**可见** | 60 秒 | 5 分钟 |
| 否则 `live-push` 的 `GET /count` 大于 0 —— 有页面**开着** | 2 分钟 | 10 分钟 |
| 两个都是 0 | 15 分钟 | 60 分钟 |

要两个数是因为它们是两个口径：`use-online-count` 在页面不可见时把连接整条关掉，所以
切走的标签页、锁了屏的手机在 online-counter 那侧算 0；`use-live-events` 那条不关，于是
它们只出现在 live-push 那个数里。中间那档就是为「切走了但还会切回来」留的 —— 切回来
那一下不该看见一刻钟前的数字，又不值得按可见那档一直打上游。可见问到了就不问第二个。

读不到（超时、非 200、形状不对、没配那个变量）一律当 0：**兜底方向是单向的**，只会往
慢里退，永远不会因为故障变快。live-push 一份生产一个，三家读的都是 Vercel 那一份，
国内那份生产上开着的页面因此不进判断 —— 少数了同样只会更慢。

`server-reporter` 和 `agent-limits-reporter` 是常驻进程，长档拆成一个个快档长度的小觉，
醒来重新问一次，该走更快那档了立刻开跑。限额每 5 分钟重查，server 每 60 秒重查，
避免从无人到有人时等满整个闲档。PlayStation 那侧不用拆，它的 cron 每分钟看一次门。

三条断流窗口都锚**最慢那档**：`SERVER_STALE_MS` / `PLAYSTATION_STALE_MS` 为
50 分钟（三轮 15 分钟加余量），`AGENT_LIMITS_STALE_MS` 为 185 分钟（三轮 60 分钟加余量）。
改闲档必须同步改 `src/lib/freshness.ts`，改另外两档不用。

## 改内容

文案、社交链接、项目、时间线全在 `src/lib/site.ts`，组件里不写死内容。标了 `占位` 的是示例文案。

## 设计约定

- 层次靠 1px 线条和表面色阶，不靠阴影；磨砂只用在吸顶导航
- 分隔线用 `screen-line-top/bottom`：内容居中，线横贯整个视口
- **整站只有实时状态区允许出现彩色**，其余全是灰阶 —— 眼睛会自动被实时数据吸走
- 全站 `tabular-nums slashed-zero`，实时数字跳动时不抖宽度
