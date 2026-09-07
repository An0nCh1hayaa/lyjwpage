# server-reporter

把日本落地节点的 CPU、内存、磁盘、网速推给 lyjwpage 的小进程，跑在节点自己上面。

站点够不着这台机器的 `/proc`（将来还要部署到 Vercel），所以该给的东西由这边送过去。
只依赖 Python 3 标准库，这台 1C2G 的 Ubuntu 上没装 Node，也不为此装。

## 它做什么

| 内容 | 节奏 | 什么时候真的推 |
| --- | --- | --- |
| CPU / 负载 / 内存 / 磁盘 / 网速 / 运行时间 | 三档：有人正看着 60 秒，页面开着但在后台 2 分钟，一个页面都没开 15 分钟 | **每轮都推**。这份快照本身就是心跳，站点拿 `pushedAt` 判断上报器还活着没有 |
| 公网 IP 的 Location / ISP / ASN | 地址变了才查，否则缓存 6 小时 | 跟着上面那份一起推。查的是网卡上的地址，不是「我访问某个 what-is-my-ip 看到的出口」 |

CPU 占用和网卡速率都是这一段间隔的平均，不是「这一瞬间的尖峰」：上一轮 `/proc` 的读数留着，这一轮做差。第一封在启动后约 1 秒就发出去，卡片不必干等一个完整间隔。

站点那侧**没有实时推送**。这些数字每个间隔都在变，广播就是拿推送当轮询用；卡片 30 秒自己来问。

每轮收尾问一次 API Worker 的 `GET /count`（超时 2.5 秒），一次拿到两个数，据此选下一轮的档：

| 问到什么 | 下一轮 | 变量 |
| --- | --- | --- |
| `online > 0` —— 有页面**可见** | 60 秒 | `LIVE_INTERVAL_MS` |
| `connections > 0` —— 有页面**开着** | 2 分钟 | `OPEN_INTERVAL_MS` |
| 两个都是 0 | 15 分钟 | `IDLE_INTERVAL_MS` |

两个数是两个口径，这也正是要两个的原因：站点侧 `use-online-count` 在页面不可见时把连接整条关掉，所以锁屏、切走的标签页在 `online` 里算 0；而 `use-live-events` 那条连接不管可不可见都挂着，它们在 `connections` 里。中间那档就是为「切走了但还会切回来」留的 —— 切回来那一下不该看见十分钟前的 CPU。

三档和另外两个上报器（agent-limits-reporter、playstation-reporter）逐档对齐，同一个概念同一个数。这份快照每轮必发（它本身就是心跳），30 秒一轮时 `/api/ingest/server` 是站点函数调用量最大的一条路径，实测 12 小时 1.5K 次。人头数读不回来一律当 0，只会往慢里退，永远不会因为故障变快。

长档不是一觉睡满：拆成一个个快档长度的小觉，每觉醒来重新问一次人头数，该走更快那档了就立刻回去开跑。否则「从没人到有人正看着」最坏要等满一个慢档（15 分钟），而那正是有人盯着屏幕等的那一刻。上一轮出错时走的是退避表，那段时间不问人头数。

卡片那侧仍是 30 秒一问（和充电头一档），比快档还勤 —— 多出来那一趟拿到的是同一份数字，是有意留的：那是浏览器自己的节奏，不该由上报器的档位决定。

人数读取上报使用的同一个 `SITE_URL`，所有连接该 API Worker 的页面都计入判断。

断流窗口锚的是**慢档**：站点 `lib/freshness` 的 `SERVER_STALE_MS` 默认 50 分钟 = 三轮 + 缓存余量，和另外两路的窗口同一个数。改慢档必须同步改那边，改另外两档不用。顺序是**站点那侧先放宽窗口并部署，这边再降频**，反过来做中间那段时间卡片会一直显示离线。

## 配置

全部走环境变量。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `SITE_URL` | ✅ | 上报 Worker 的源，如 `https://api.homepage.lyjw.llc`。上报端点和人头数的 `/count` 都由上报器从它拼 |
| `SITE_INGEST_URL` | | 直接给完整端点，给了就不用 `SITE_URL` 上报；人头数仍只从 `SITE_URL` 读，没配就永远走最慢那档 |
| `TELEMETRY_INGEST_SECRET` | ✅ | 和站点同名变量对上，作 Bearer 鉴权。站点没配时才可留空 |
| `HOST_ID` | | 默认 `misaka-jp`，卡片上认的名字 |
| `HOST_LOCATION` | | 默认 `Tokyo`，机房所在城市。站点不从 IP 猜 |
| `LIVE_INTERVAL_MS` | | 默认 `60000`，有人正看着那一档 |
| `OPEN_INTERVAL_MS` | | 默认 `120000`，页面开着但都在后台那一档 |
| `IDLE_INTERVAL_MS` | | 默认 `900000`，一个页面都没开那一档。站点的 `SERVER_STALE_MS` 锚着它 |
| `COUNT_TIMEOUT_MS` | | 默认 `2500`，问人头数那一次请求的超时 |
| `PUSH_TIMEOUT_MS` | | 默认 `10000` |

## 在 VPS 上跑

部署单元是 systemd，不是 Docker —— 这台机器上没有 Docker，为这一个进程拉守护进程也不值。

拷过去（`scp` 不一定可用，走 tar 管道）：

```bash
COPYFILE_DISABLE=1 tar czf - -C reporters --exclude .env server-reporter \
  | ssh misaka-jp 'mkdir -p /opt/lyjwpage && tar xzf - -C /opt/lyjwpage'
```

`.env` 单独送，别混进源码目录一起打包：

```bash
ssh misaka-jp 'cat > /opt/lyjwpage/server-reporter/.env && chmod 600 /opt/lyjwpage/server-reporter/.env' < 本机那份.env
```

装 unit、拉起来：

```bash
ssh misaka-jp 'install -m 644 /opt/lyjwpage/server-reporter/server-reporter.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now server-reporter'
```

生产的 `SITE_URL` 统一填 `https://api.homepage.lyjw.llc`，不经 Vercel 站点。

看日志：`journalctl -u server-reporter -f`。

## 容错

- 站点连不上只是这一轮作废，进程不退；下一轮照常重试，间隔从这一档起每连错一次翻倍，到 5 分钟封顶，跑通一次就复位。
- 同一个环节连续报错只在第一次和恢复时各写一句日志，中间每满 10 次再报一次。
- 网卡取默认路由那块（这台是 `enp3s0`），`lo` 不算。默认路由暂时没有时这一轮失败，不瞎猜一块。
