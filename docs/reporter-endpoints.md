# 生产上报端点核验

2026-09-07（UTC+8）核验。统一源为 `https://api.homepage.lyjw.llc`，生产 Worker 名为 `api`。
所有七个来源均在新 Worker 日志中确认真实 POST 返回 202；HomePod 的两个实例还分别检查了 Home Assistant 动作回执。

| 来源 | 当前实例 | 路径 | 结果 |
| --- | --- | --- | --- |
| Mac | 本机 Mac Telemetry Hub | `/api/ingest/mac` | 设置已保存；连续真实上报 202 |
| server | `ssh -J cvm misaka-jp`，`server-reporter.service` | `/api/ingest/server` | 配置已更新、服务 active；真实上报 202 |
| Emby | `ssh dsm`，容器 `homepage-reporter` | `/api/ingest/emby` | 容器已应用新配置；真实上报 202 |
| agents | `ssh dsm`，容器 `agent-limits-reporter` | `/api/ingest/agents` | 容器已应用新配置；真实上报 202 |
| PlayStation | Worker `playstation-reporter` | `/api/ingest/playstation` | `SITE_URL` 已更新并部署；真实上报 202 |
| HomePod | `ssh dsm`，Home Assistant `media_player.wo_shi` | `/api/ingest/homepod` | 配置检查通过；真实 rest_command 返回 202 |
| HomePod | `ssh n100`，Home Assistant `media_player.zhu_wo_lyjw` | `/api/ingest/homepod` | 配置检查通过；真实 rest_command 返回 202 |
| iPhone | iPhone 17 Pro，遥测中心 | `/api/ingest/iphone` | 用户修改设置；App 显示成功，新 Worker 收到 202 |

两台 Home Assistant 已重启应用配置；验证只调用 `rest_command.push_homepod_now_playing` 上报当前实况，没有控制 HomePod 播放，也没有发送合成数据。
iPhone 最新活动数据已在生产主页显示为活动 334 / 270 千卡、锻炼 25 / 30 分钟、站立 8 / 10 小时（核验时快照）。

## 站点与持久化

主账号 Vercel 和小账号生产 Vercel 的 Production / Preview `NEXT_PUBLIC_BACKEND_URL` 均为新域名。
`lyjw.me` 的浏览器状态查询直连新 API，`/ws`、`/online/ws` 均握手 101。
Worker 的三个 SQLite Durable Object 命名空间通过 transfer migration 迁移，ID 和数据保持不变：

| 类 | 命名空间 ID |
| --- | --- |
| LivePushRoom | `7d366bc728244a71b06ce6cbd8267539` |
| OnlineCounterRoom | `1aa4f5ed35f14a258005da8583342661` |
| StateHub | `08a6c22e048d4a9b915ba869ad40ffee` |

生产使用 Vercel / Workers；腾讯云 EdgeOne 部署已退役。

## 配置备份

每份远端配置修改前均保留原文件权限与时间戳备份，后缀为 `.before-api-20260907`。

| 主机 | 原路径 | 应用命令 |
| --- | --- | --- |
| dsm | `/volume3/docker/agent-limits-reporter/.env` | `/usr/local/bin/docker compose -f /volume3/docker/agent-limits-reporter/compose.yaml up -d --no-deps --no-build agent-limits-reporter` |
| dsm | `/volume3/docker/emby-proxy/.env` | `/usr/local/bin/docker compose -f /volume3/docker/emby-proxy/docker-compose.yml up -d --no-deps --no-build emby-reporter` |
| dsm | `/volume3/docker/homeassistant/homeassistant/configuration.yaml` | Home Assistant 的 `rest_command.reload` 动作，或重启 `homeassistant` 容器 |
| n100 | `/volume1/docker/homeassistant/homeassistant/configuration.yaml` | Home Assistant 的 `rest_command.reload` 动作，或重启 `homeassistant` 容器 |
| misaka-jp | `/opt/lyjwpage/server-reporter/.env` | `systemctl restart server-reporter` |

备份路径是原路径加上述后缀。原 Worker / 域名退役后，不要单独恢复备份中的旧目的地；如需整体回滚，先恢复后端域名与服务，再切换调用方。
