# 生产上报端点核验

2026-09-07（UTC+8）迁移中核验。统一源为 `https://api.homepage.lyjw.llc`。
下表的成功指真实上报返回 202，并在 Worker 日志中核对来源与中继标记；不是仅凭配置文件判断。

| 来源 | 当前实例 | 路径 | 结果 |
| --- | --- | --- | --- |
| Mac | 本机 Mac Telemetry Hub | `/api/ingest/mac` | 直连成功 |
| server | `ssh -J cvm misaka-jp`，`server-reporter.service` | `/api/ingest/server` | 直连成功 |
| Emby | `ssh dsm`，容器 `homepage-reporter` | `/api/ingest/emby` | 直连成功 |
| agents | `ssh dsm`，容器 `agent-limits-reporter` | `/api/ingest/agents` | 直连成功 |
| PlayStation | Worker `playstation-reporter` | `/api/ingest/playstation` | 自动部署后直连成功 |
| HomePod | `ssh dsm`，Home Assistant `media_player.wo_shi` | `/api/ingest/homepod` | 实际 rest_command 返回 202；当前 off |
| HomePod | `ssh n100`，Home Assistant `media_player.zhu_wo_lyjw` | `/api/ingest/homepod` | 实际 rest_command 返回 202；当前 idle |
| iPhone | iPhone 17 Pro，iPhone Telemetry Hub | `/api/ingest/iphone` | 仍指向 `https://lyjw131.com/api/ingest/iphone`，用户选择稍后自行修改 |

iPhone 待完成镜像设置，应改为 `https://api.homepage.lyjw.llc/api/ingest/iphone`，保留原密钥。
本次未改动手机设置。文档和 App 的地址提示已更新，提示更新不等于已安装 App 的配置迁移。

PlayStation 配置提交为 `3cfa634`，部署版本为 `93caea56-d57d-4f39-8c19-f8b01ee0f320`。
该提交的 CI、CodeQL、Deploy Workers、Vercel 和 EdgeOne 部署均成功。
本地 PlayStation 类型检查与改动 diff 检查通过；两台 HA 的 check_config 通过。

本次验证先向 HomePod 入口发送了两个空对象，入口将其接受为 stopped 状态；
随后分别调用两台 HA 的真实 rest_command，重新上报实际 off / idle 状态并确认 202。
没有向 HomePod 发出播放控制命令。两台 HA 已重启以应用配置。

## 配置备份与回滚

只修改下列文件的目的地；保留密钥、采集频率、挂载数据和其他服务配置。
回滚时在对应主机上用 `cp -p <备份> <原路径>` 恢复，再执行该行应用命令。

| 主机 | 原路径 | 备份后缀 | 应用命令 |
| --- | --- | --- | --- |
| dsm | `/volume3/docker/agent-limits-reporter/.env` | `.before-direct-worker-20260906-091948` | `/usr/local/bin/docker compose -f /volume3/docker/agent-limits-reporter/compose.yaml up -d --no-deps --no-build agent-limits-reporter` |
| dsm | `/volume3/docker/emby-proxy/.env` | `.before-direct-worker-20260906-091948` | `/usr/local/bin/docker compose -f /volume3/docker/emby-proxy/docker-compose.yml up -d --no-deps --no-build emby-reporter` |
| dsm | `/volume3/docker/homeassistant/homeassistant/configuration.yaml` | `.before-direct-worker-20260906-091948` | `/usr/local/bin/docker restart homeassistant` |
| n100 | `/volume1/docker/homeassistant/homeassistant/configuration.yaml` | `.before-direct-worker-20260906-092351` | `/usr/local/bin/docker restart homeassistant` |
| misaka-jp | `/opt/lyjwpage/server-reporter/.env` | `.before-direct-worker-20260906-011951` | `systemctl restart server-reporter` |

备份路径是原路径加上对应后缀。Home Assistant 回滚后先运行
`/usr/local/bin/docker exec homeassistant python -m homeassistant --script check_config --config /config`，
检查通过再重启。
