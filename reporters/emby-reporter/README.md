# emby-reporter

把内网 Emby 的状态推给 lyjwpage 的小代理，跑在 NAS 上。

站点将来要部署到 Vercel，那时它够不着局域网里的 Emby（`http://emby.local:8096`），
所以站点侧已经删光了对 Emby 的主动请求。该给的东西改由这个代理送过去。

## 它做四件事

| 内容 | 节奏 | 什么时候真的推 |
| --- | --- | --- |
| 续播列表（`Users/{id}/Items/Resume`，含单集详情） | 60 秒一轮 | 列表内容有变化时；另外每 10 分钟兜底整推一次 |
| 播放位置（`/Sessions`） | 在播时 2 秒一轮，空闲时 5 分钟 | 换片、暂停状态变了、或位置偏离站点推算值超过 1.5 秒（也就是拖了进度条） |
| 海报（`Items/{id}/Images/...`） | 跟着上面两条走 | 上报器一次压成 WebP 并直传 R2；只把对象键推给站点，按 Emby 的 ImageTag 判变 |
| 转发 Emby 的播放通知 | 事件驱动 | 收到就转 |

**Emby 的 webhook 现在发给这个代理，不再直发站点。** Emby 后台那个配置项加不了
自定义请求头，直发站点就只能开一个不鉴权的入口；经代理转发后，站点只保留
`TELEMETRY_INGEST_SECRET` 这一种鉴权方式。

事件本身只当触发器用，位置、暂停状态、设备名一律以 `/Sessions` 的回答为准 ——
webhook 各版本的字段位置本来就不一致，用它带的值等于把版本差异一路带进站点。

事件顺带当作会话轮询的开关：**收到「开始播放」才起 2 秒那一档，「停止」就歇下来**，
没人看片时不盲轮。空闲那一档 5 分钟仍留着，是漏收 webhook 时的兜底。

位置为什么不是 2 秒一推：站点是按「上次锚点 + 真实流逝时间」自己把进度条推着走的，
正常播放它算得准，只有拖了进度条才会偏。站点将来在 Vercel 上是按调用计费的函数，
一小时白推 1800 次没有道理。

## 配置

全部走环境变量。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `EMBY_URL` | ✅ | 内网地址，如 `http://emby.local:8096` |
| `EMBY_API_KEY` | ✅ | Emby 后台「高级 → API 密钥」 |
| `EMBY_USER_ID` | ✅ | 要跟的那个用户；别人在看什么不会被推出去 |
| `SITE_URL` | ✅ | 上报 Worker 的源，如 `https://api.homepage.lyjw.llc`。端点路径由上报器自己拼 |
| `SITE_INGEST_URL` | | 直接给完整端点，给了就不用 `SITE_URL` |
| `TELEMETRY_INGEST_SECRET` | ✅ | 和站点同名变量对上，作 Bearer 鉴权。站点没配时才可留空 |
| `R2_ENDPOINT` | ✅ | R2 S3 API 地址，如 `https://<account>.r2.cloudflarestorage.com` |
| `R2_BUCKET` | ✅ | 图片 bucket 名称 |
| `R2_ACCESS_KEY_ID` | ✅ | 只授予该 bucket 写权限的访问密钥 ID |
| `R2_SECRET_ACCESS_KEY` | ✅ | 对应的访问密钥；只留在 NAS 上报器环境变量中 |
| `WEBHOOK_PORT` | | 默认 `8787`，Emby 的播放通知发到这里 |
| `WEBHOOK_TOKEN` | | webhook 的共享密钥。配了就要求通知地址带 `?token=<值>`，**留空 = 局域网里谁都能发** |
| `RESUME_INTERVAL_MS` | | 默认 `60000` |
| `RESUME_LIMIT` | | 默认 `8`，站点也只展示这么多 |
| `SESSION_ACTIVE_INTERVAL_MS` | | 默认 `2000` |
| `SESSION_IDLE_INTERVAL_MS` | | 默认 `300000`，漏收 webhook 时的兜底 |
| `WAKE_WINDOW_MS` | | 默认 `30000`，收到事件后至少按活跃档跟这么久 |
| `SEEK_TOLERANCE_MS` | | 默认 `1500`，判定「拖了进度条」的阈值 |
| `REANCHOR_MS` | | 默认 `30000`，没拖动也隔这么久重新落一次锚 |
| `FULL_PUSH_INTERVAL_MS` | | 默认 `600000`，没变化也兜底整推的间隔 |
| `IMAGES_PER_PUSH` | | 默认 `4`，一次推送最多捎几张图 |
| `REQUEST_TIMEOUT_MS` | | 默认 `10000`，问 Emby 和传 R2 用 |
| `PUSH_TIMEOUT_MS` | | 默认 `30000`，带图的推送会大很多 |
| `WEBHOOK_HOST_PORT` | | 默认 `8787`，映射到容器内的 `WEBHOOK_PORT` |

## 在 NAS 上跑

部署单元是同目录的 [compose.yaml](compose.yaml)：把这个目录整个拷到 NAS、旁边放一份
`.env`，就地 build。**别在 Mac 上 build 完把镜像拷过去** —— Mac 是 arm64、群晖是
x86_64，架构对不上。

容器里的端口固定 8787，宿主端口由 `.env` 的 `WEBHOOK_HOST_PORT` 决定：
nas-host 上 8787 已经归 `homepage-reporter`，那台填 8788。

拷过去（nas-host 的 sftp 子系统是关的，`scp` 用不了，走 tar 管道）：

```bash
COPYFILE_DISABLE=1 tar czf - -C reporters --exclude node_modules --exclude dist emby-reporter | ssh nas-host 'mkdir -p /srv/lyjwpage && tar xzf - -C /srv/lyjwpage'
```

`.env` 单独送，别混进源码目录一起打包：

```bash
ssh nas-host 'cat > /srv/lyjwpage/emby-reporter/.env && chmod 600 /srv/lyjwpage/emby-reporter/.env' < 本机那份.env
```

起：

```bash
ssh nas-host '/usr/local/bin/docker compose -f /srv/lyjwpage/emby-reporter/compose.yaml up -d --build'
```

（`docker` 不在群晖的非交互 PATH 里，得写绝对路径。`-f` 指到哪个文件，compose 就拿
那个目录当项目目录 —— `.env` 和项目名都从那儿取，不会和 NAS 上别的 compose 项目串。）

生产的 `SITE_URL` 统一填 `https://api.homepage.lyjw.llc`，不经 Vercel 或 EdgeOne 站点。

不进容器直接跑也行（Node ≥ 20），在仓库根目录：
`pnpm --filter @lyjwpage/emby-reporter build && node reporters/emby-reporter/dist/index.js`。

## Emby 侧怎么配

后台「通知 → 添加通知 → Webhooks」，地址填**代理**而不是站点。代理在 nas-host 上、
Emby 在 emby-host 上，所以填 nas-host 的局域网地址和上面那个宿主端口：

```text
http://reporter.local:8788/webhook
```

（哪天两者同机就填 `http://localhost:<宿主端口>/webhook`；Emby 自己跑在容器里的话
用容器网络里的服务名。）请求方式 POST、内容 JSON，勾上播放开始 / 暂停 / 继续 / 停止。
路径其实不校验，POST 到哪个路径都收 —— 各版本的 Emby 对地址的处理不太一样，
少一个能配错的地方。

**这个端口默认不鉴权**：局域网里任意一台机器发一条伪造的 `playback.stop` 就能抹掉
站点上「正在观看」的卡片，伪造 `start` 则能把会话轮询顶到 2 秒一档。同网段设备不
都可信的话，在 `.env` 里配一个 `WEBHOOK_TOKEN`，通知地址跟着带上：

```text
http://reporter.local:8788/webhook?token=<和 WEBHOOK_TOKEN 一样的值>
```

Emby 的通知配置项加不了自定义请求头，但地址里的 query 是能带的 —— 所以密钥走
query 而不是 header。**改了 `WEBHOOK_TOKEN` 记得同步改 Emby 后台那条地址**，
忘了改等于把 webhook 唤醒关掉了（表现为开播要等下一轮空闲轮询才被发现）。

## 容错

- Emby 或站点连不上都只是这一轮作废，进程不退；下一轮照常重试。
- 转发失败（站点重部署、网络断了）不会丢状态：会话循环每 30 秒重新落一次锚，
  下一轮就把最新的位置补上；停止事件转发失败时，站点那份状态自己会推算到片尾作废。
- 代理重启后第一轮查到没人在播，会明确给站点清一次 —— 我们手上是空的，
  而站点那份还留着重启前的「正在播放」，没人更正的话它会一直挂着。
- 同一个环节连续报错只在第一次和恢复时各写一句日志，中间每满 10 次再报一次，
  免得 `docker logs` 被同一条「连接被拒绝」刷满。
- 站点的响应里带 `missingImages`（它引用了却没有的图片键）。Redis 被清空、
  容器换了机器之后，代理据此把图补传回去，不需要人工干预。
- 同一张图连着试三次不成，就不再试了。两种失败共用这个上限：一种是送到站点了、
  站点还说没有（R2 对象校验没通过，而图片键跟着 ImageTag 走不会自己变，一直重试
  只会变成死循环），另一种是压根取不到 / 传不上去（条目被删、Emby 404、R2 凭据
  过期）。后一种到上限也要出队 —— 每轮固定取队头四张，一张永远取不到的图不出队
  就会把后面排队的海报全堵住。
- Emby 或站点出错时下一次重试是 2 秒后，连着错才逐次翻倍退到 5 分钟（跑通一次
  就复位）。正在播放时抖一下不该按「空闲」处理：站点那侧还在按锚点推进度条，
  断供多久就偏多久。
