# playstation-reporter

Cloudflare Worker 上的 PSN 上报器：cron 每分钟响一次，前面挡一道门 —— 有人正看着
站点就 60 秒一轮完整 tick，页面只是开着（后台标签页、锁了屏的手机）2 分钟一轮，
一个页面都没开 15 分钟一轮。presence 每轮都推（站点靠它的
`observedAt` 判上报器死活）；playedGames 和奖杯只在内容变化时才带上。闲着不玩的时候
游玩列表和购买库走 KV 缓存，奖杯只打总览那一下 —— 等级和杯数没变就不再翻目录、
不重爬明细。个人资料（onlineId / 头像 / Plus）另走 1 天 TTL：过期了 quiet 也要
重拉，还新鲜时 dirty 重爬也不再打资料接口。真有解锁时只重拉 `lastUpdated` 变了
的那几款，定义（名字 / 分组）还能复用上次的，每款 4 次出网变成 2 次。变了的款
当轮爬完、对齐、整份交付。

鉴权链和两个读取端点已经用真实凭据跑通，也确认 `Accept-Language: zh-Hans` 会返回
官方中文名。ingest Worker 的 `/api/ingest/playstation` 已经存在，`wrangler.toml` 里也配了
`SITE_URL`，所以默认不是 dry-run。

## 调度与状态

只有一个 Cron Trigger：`* * * * *`。**每分钟响一次不等于每分钟跑一轮** —— 每一响
先过一道门，门开了才是一轮完整 tick：

- 读 KV 里 `meta:lastFullTick`（上一轮完整 tick 的**开始**时刻）；
- 攒够 14.5 分钟就直接放行，连人头数都不问 —— 闲时节奏不该依赖另外两个 worker 可不可达；
- 不到 55 秒直接挡回去；
- 中间那段先问 `online-counter` 的 `GET /count`（超时 2.5 秒）：有页面**可见**就放行；
- 都不可见、且已经攒够 115 秒，再问 `live-push` 的 `GET /count`：有页面**开着**就放行。

两个数是两个口径：站点侧 `use-online-count` 在页面不可见时把连接整条关掉，所以切走的
标签页、锁了屏的手机在 online-counter 那侧算 0；`use-live-events` 那条不关，所以它们
只在 live-push 那个数里。中间那档就是为「切走了但还会切回来」留的。

于是有人正看着时是 60 秒一轮，presence 有分钟级新鲜度；只是开着时 2 分钟一轮；一个
页面都没开时每分钟的 cron 把 14.5 分钟这个阈值取整成 15 分钟一轮，**和从前那根十五
分钟的 cron 逐轮对齐，闲时对 PSN 的流量一模一样**。动机就是这个：presence 的新鲜度
跟着有没有人看走，没人看的时候一分钱不多花。

门里只有那三个读操作，并且层层短路、排在任何贵操作之前 —— 被挡下的那一响完全不碰
PSN、不碰站点。人头数超时、非 200、返回形状不对，一律**当 0 处理**：兜底方向是单向的，
读不到只会往慢里退，永远不会因为故障变快。

KV 的读带最长 60 秒的边缘缓存，正好压在 55 秒这个阈值上，所以门还看一眼 isolate
本地那份开始时刻，和 KV 那份取较晚的一枚 —— 否则相邻两响里后一响可能还读着旧值，
把同一轮放行两次。冷起时本地那份是 0，退回纯 KV 判断。

间隔算的是上一轮**开始**的时刻，不是成功的时刻。这枚时间戳在打 PSN 之前就写下，
所以 PSN 持续故障时重试仍是十五分钟一次，不会恶化成每分钟一次；tick 被硬杀掉
（比如 CPU 超时）也不会让门以为「上一轮还没开始过」。也正因如此它和收尾才写的
`meta:lastTick` 是两枚，不能合并。

站点侧的断流窗口（`src/lib/freshness.ts` 的 `PLAYSTATION_STALE_MS`，50 分钟）锚的是
**闲时**那一档：三轮 15 分钟加缓存余量。改闲时间隔要同步改那边，改 cron 本身不用。

`wrangler dev` 不会自己响这根 cron，本地要跑一轮就 `GET /tick`（不走门，走缓存）；
`GET /` 是忽略所有缓存的全量刷新，见下面「手动触发」。每轮顺序执行：

1. presence 和奖杯总览并行；
2. 游玩列表走 TTL：在玩 15 分钟、闲着 1 小时，过期才去拉，否则用缓存。在玩那档
   刻意等于闲时的完整 tick 节奏 —— 时长和游玩次数没有分钟级精度可言，快节奏下
   不该每分钟翻一遍分页列表。奖杯没变时只翻
   最近窗口（`PLAYED_GAMES_LIMIT`）盖进缓存，不必为时长把整库翻完。带
   `Accept-Language`；
3. 购买库（PS4 / PS5）同样走缓存，6 小时才翻一遍，和游玩列表并行。把 `service` /
   预购接到游玩列表；没开过档的预购追加在最近窗口之后，不混进
   `PLAYED_GAMES_LIMIT`；
4. 奖杯总览的等级 / 总杯数 / 屏蔽名单都没变就收工。个人资料（onlineId /
   avatarUrl / plus）按 1 天 TTL 单独判断：过期了 quiet 也打一次
   `getProfileFromAccountId` 并整份交付，否则头像 / Plus 不会自己刷新；还新鲜时
   即使 dirty 重爬也沿用，等级 / 总杯数仍用本轮 summary 覆盖。变了才翻目录，跟
   KV 里上次交付的快照比：只重爬进度、`lastUpdated`、定义/获得杯数对不上的款，
   两款并行。定义杯数没变就只打「获得情况」两个接口，变了（新 DLC）才四个都打。
   没变的款从 `trophies:last` 合并进来。然后做 `titleId` 对齐
   （`getUserTrophiesForSpecificTitle`，PPSA… → NPWR…）：已经对着的 SKU 不再打，
   只补还没映射的；万一新 NPWR 挂在旧 SKU 上才整表再对一次。对齐必须看见完整
   游玩列表，否则屏蔽的 titleId 对不上。这一轮失败不写指纹，下一轮相对上次成功
   交付重算 dirty 再来 —— 不拿两个时点的半份明细拼假目录。分页之间不再固定
   sleep，上游 429 才退避重试；
5. 按 `PLAYSTATION_HIDDEN_TITLE_IDS` 去掉屏蔽的 titleId（不上报），再按
   `PLAYED_GAMES_LIMIT`（默认 100）切开，接上未开档预购；
6. 交付两封 v1 信封：第一封必带 presence，playedGames 变了才一起带；奖杯只在整份
   目录拼齐后另发一封，绝不交付部分目录。两封各自 try/catch，各自成功才写各自的
   指纹 —— 一封被站点 400 不会连累另一封。交付成功后写下 `trophies:last`。

拆成两封是因为站点的校验是信封级的全有全无：几百 KB 的奖杯目录里一个字段越界就退整封，
心跳不该跟着一起丢。同理，会越界的值在 Worker 里就钳好（百分比 0–100、id 非负整数、
空串回落），不指望上游一直守规矩。

上游报错也不当数据用：psn-api 2.18.1 有一半取数函数遇 429 / 401 既不抛也不看 HTTP
状态码，原样把 `{error:{…}}` 交回来，所以 Worker 对这些调用自己断言一遍；分页端点
另外拿 `totalItemCount` 对一遍条数。被限流的那一轮就干净地失败：指纹不写，下一轮
重试，而不是把空目录当权威数据交上去。门那枚时间戳在开跑前就写，不管这一轮成不成，
所以持续失败时的重试节奏和平时的节奏是同一个，不会因为失败而变密。

没有定时兜底整推。状态全部放在绑定 `STATE` 的 Workers KV：

| KV key | 内容 |
| --- | --- |
| `auth` | token 状态 JSON，形状与旧 `state/auth.json` 完全相同 |
| `fp:playedGames` | played games 内容指纹 |
| `fp:trophies` | 奖杯总览指纹（等级 + 各标题完成度 / 定义杯数 / lastUpdated），并入屏蔽名单和两枚口径哨兵：口径一改指纹就变 |
| `trophies:last` | 上次成功交付的整份目录 + 索引快照，增量重爬的对照面；站点仍然整份替换。`profile.fetchedAt` 是上次拉 onlineId / 头像 / Plus 的时刻，1 天内复用；缺席当过期 |
| `cache:playedGames` | 全份游玩列表，在玩时 15 分钟、闲置时 1 小时内不重拉 |
| `cache:library` | 购买库，6 小时内不重拉 |
| `meta:lastTick` | 最近一轮时间、成功与否、playedGames / 奖杯有没有变、dry-run 状态。收尾时写 |
| `meta:lastFullTick` | 上一轮完整 tick 的开始时刻（纯数字），门算间隔用。开跑前写 |

presence 没有指纹：每轮必发，无所谓变没变。

`auth` 的字段固定为 `accessToken`、`refreshToken`、`accessTokenIssuedAt`、
`accessTokenExpiresAt`、`refreshTokenIssuedAt`、`refreshTokenExpiresAt`；四个时间都是
epoch 毫秒。现有文件可以原样种进 KV。

Worker 的 HTTP `fetch` 是手动触发入口，两条都**不走门**，都刷新 `meta:lastFullTick`
（手动跑完之后下一轮定时的跟着往后顺延），都把这轮的元信息和 presence、played games
一并返回，出错回 502 并带上错误和 KV 里最近一轮的记录 —— 任何一封信没交付成功，
这一轮都算失败：

- `GET /` —— **全量刷新，忽略所有缓存**。把这一轮当成 KV 空着跑：游玩列表整份翻
  （不按 `PLAYED_GAMES_LIMIT` 截）、购买库重拉、奖杯目录每款重爬（不复用定义）、
  资料重问，两封信不比指纹都交付，`meta:lastTick` 上记 `forced: true`。购买库拉不到
  就整轮失败，不会交一份没有预购的列表上去。贵：每款奖杯 4 次出网、每款游戏一次
  对齐，和第一次冷启动那轮同量，别接进监控或定时器。本地 `wrangler dev` 时
  Chrome / Cursor 探调试口会打 `/json/version` 再连打根路径，同一 isolate 里会被压成
  一轮，但那一轮仍是全量的 —— 本地别拿浏览器开根路径。
- `GET /tick` —— 普通一轮：该走缓存走缓存、比指纹、变了才交付，奖杯没变时
  `trophies` 为 null。想看某样东西「按正常节奏会不会刷」就打这条。

`/favicon.ico` 和其余路径 404。

Worker 自己不做鉴权，访问控制交给前面的 Cloudflare Access；token 永远不出现在
响应里。

## 鉴权

整条链由 `psn-api` 2.18.1 的三个 exchange 函数负责：

```text
NPSSO → access code → access token + refresh token → refresh 续期
```

access token 过「签发 → 到期」的中点就续；业务请求遇到 401 会强制续一次并重试一次。
refresh 被上游拒绝时才退回 NPSSO，超时、断网等网络错误原样抛出，避免拿 NPSSO 去撞
网络故障。真实凭据观察到 refresh token 有效期约 10 天，不是旧文档所写的约两个月；
具体期限始终以上游响应为准。

NPSSO 是 Worker secret `PSN_NPSSO`，可以缺席：KV 的 `auth` 里还有有效 refresh token
时不需要它。重新生成 NPSSO 会立即作废上一串；也不要从 PlayStation 网站登出，登出会
让已经发出的 token 在七天内软失效。

## 语言与规范化

`PSN_LANGUAGE` 在 `wrangler.toml` 的 `[vars]` 中默认是 `zh-Hans`。
`PLAYED_GAMES_LIMIT` 默认 100。`PLAYSTATION_HIDDEN_TITLE_IDS` 是逗号分隔的
titleId，屏蔽的游戏不上报、不占窗口；改这份名单会重推奖杯目录。presence 和
奖杯接口通过 psn-api 的 `headerOverrides` 发送 `Accept-Language`。

「玩过的游戏」仍是唯一例外：psn-api 2.18.1 的 `getUserPlayedGames` 不接
`headerOverrides`，实现也不发语言头，所以 `src/psn.ts` 继续直接请求与它相同的
`…/users/:accountId/titles` 端点。上游补上这个入口后才能切回库函数。
游玩列表已经是中文元数据；奖杯标题对不上时用这份名字做 `localizedName`，
不手写中英对照。

规范化在 Worker 内做完：ISO 时间戳转 epoch 毫秒，ISO-8601 时长转毫秒，平台名统一
大写；对上游响应保留可选链与兜底。`category` 是上游枚举，已实测还会出现
`ps5_native_media_app`（YouTube / Netflix），其余常见值包括 `ps4_game`、
`ps5_native_game`、`pspc_game` 和 `unknown`。
`service` 同样是上游枚举，已实测 `ps_plus` / `none(purchased)` / `other`；
`ps_plus` 表示当前这份 entitlement 来自 Plus 会员库。预购来自购买库的
`isPreOrder`，没对上就是 `false`。买断后 `service` 可能变成 `none(purchased)`，
即使这款曾经在 Plus 目录里。

## 信封

三部分各自可省，站点收到哪部分就只更新哪部分。实际发出的是两封：
`presence`（+ 变化时的 `playedGames`）一封，`trophies` 单独一封。

```jsonc
{
  "version": 1,
  "presence": {
    "observedAt": 1787599316815,
    "online": true,
    "availability": "availableToPlay",
    "platform": "PS5",
    "lastOnlineAt": 1685827528987,
    "playing": {
      "titleId": "PPSA01521_00",
      "title": "Horizon Forbidden West",
      "format": "PS5",
      "launchPlatform": "PS5",
      "iconUrl": "https://image.api.playstation.com/…"
    }
  },
  "playedGames": {
    "observedAt": 1787599316816,
    "items": [
      {
        "titleId": "PPSA01521_00",
        "name": "Horizon Forbidden West",
        "category": "ps5_native_game",
        "playCount": 100,
        "firstPlayedAt": 1436557219000,
        "lastPlayedAt": 1722713307120,
        "playDurationMs": 824193000,
        "imageUrl": "https://image.api.playstation.com/…",
        "service": "none(purchased)",
        "preOrder": false
      }
    ]
  }
}
```

奖杯那封：`titles` 是整份目录，每条带自己的奖杯组和逐个奖杯，站点整份替换。

```jsonc
{
  "version": 1,
  "trophies": {
    "observedAt": 1787599316820,
    "profile": {
      "onlineId": "…",
      "avatarUrl": "https://image.api.playstation.com/…",
      "plus": true,
      "level": 412,
      "tier": 5,
      "trophyPoint": 74190,
      "levelBasePoint": 73920,
      "levelNextPoint": 74880,
      "levelProgress": 28,
      "earned": { "platinum": 21, "gold": 96, "silver": 312, "bronze": 1174 }
    },
    "titles": [
      {
        "npCommunicationId": "NPWR20188_00",
        "name": "Horizon Forbidden West",
        "localizedName": "地平线 西之绝境",
        "titleIds": ["PPSA01521_00", "PPSA01522_00"],
        "iconUrl": "https://image.api.playstation.com/…",
        "platform": "PS5",
        "progress": 64,
        "defined": { "platinum": 1, "gold": 2, "silver": 12, "bronze": 64 },
        "earned": { "platinum": 0, "gold": 1, "silver": 8, "bronze": 41 },
        "lastUpdatedAt": 1722713307000,
        "playDurationMs": 824193000,
        "playCount": 100,
        "firstPlayedAt": 1436557219000,
        "lastPlayedAt": 1722713307120,
        "service": "none(purchased)",
        "preOrder": false,
        "groups": [
          {
            "id": "default",
            "name": "地平线 西之绝境",
            "iconUrl": "https://image.api.playstation.com/…",
            "progress": 64,
            "defined": { "platinum": 1, "gold": 2, "silver": 12, "bronze": 64 },
            "earned": { "platinum": 0, "gold": 1, "silver": 8, "bronze": 41 }
          }
        ],
        "trophies": [
          {
            "id": 0,
            "type": "platinum",
            "name": "西之绝境的英雄",
            "detail": "获得全部奖杯",
            "iconUrl": "https://image.api.playstation.com/…",
            "hidden": false,
            "groupId": "default",
            "earned": false,
            "earnedAt": null,
            "earnedRate": 3.2
          }
        ]
      }
    ]
  }
}
```

配了 `SITE_INGEST_URL` 就直接使用；否则由 `SITE_URL` 拼
`/api/ingest/playstation`。两者都没配才是 dry-run；现在 `wrangler.toml` 里配了
`SITE_URL`，所以默认走真推。真推时可选 secret `TELEMETRY_INGEST_SECRET`
会作为 Bearer token。

## 部署

推到 `main` 且这个目录有改动时，`.github/workflows/deploy-workers.yml` 会自动部署，
不用在本机执行 `wrangler deploy`。首次部署后有两类手工动作：

1. 把备份的旧 `state/auth.json` 原样写到 KV key `auth`；
2. 按需要写入 secret：`PSN_NPSSO`，以及站点侧要求鉴权时用的
   `TELEMETRY_INGEST_SECRET`。

`SITE_URL=https://ingest.homepage.lyjw.llc` 已经在 `wrangler.toml` 里配好，不必再动。要临时回到 dry-run 就把它注释掉。

`ONLINE_COUNTER_URL` 和 `LIVE_PUSH_URL` 同样配好了，填的都是那两个 worker 的**源**
（路径由这边拼 `/count`，和站点侧 `NEXT_PUBLIC_ONLINE_COUNTER_URL` /
`NEXT_PUBLIC_LIVE_PUSH_URL` 同一个形状）。注释掉不会让上报停摆，只是对应那一档用不上，
一路退到 15 分钟一轮的基线节奏。live-push 一份生产一个，填的是 Vercel 那一份 ——
国内那份生产上开着的页面因此不进判断，少数了只会更慢。

本目录是独立 npm 部署单元，保留自己的 `package-lock.json`。重生成时必须在没有
`node_modules` 的干净状态运行 `npm install --package-lock-only`，否则根工作区的 pnpm
软链可能被写进锁文件，CI 的 `npm ci` 无法复现。

本地只做类型检查：

```bash
npm ci
npm run typecheck
```
