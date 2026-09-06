<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# 工作方式

- 根据用户目标和已有上下文完成实现与必要验证；常规、可逆的实现选择自行决定，有影响的假设简短说明。用户中途补充要求或询问进度时，结合新信息继续原任务。
- 已授权的检查、修改和修复直接推进。只有缺失信息会实质改变结果且无法从代码推断，或下一步超出授权范围时才询问；等待期间继续不依赖答案的工作。需要批准时，先准备好可审阅的改动和验证结果。
- 在遵守系统、开发者指令和工具权限的前提下，用户明确要求优先于本文件和技能中的默认建议。技能若导致暂停或要求确认，指出实际读取的文件、具体条款和适用原因，不把自己的推断当成硬性要求。
- 默认用简洁中文沟通，先说结果，再说明关键原因、验证和剩余问题。只报告实际完成的工作；区分本地修改、测试通过和已部署。

# 项目入口与验证

- 使用 `pnpm`；命令以各目录的 `package.json` 为准。主站开发入口是 `pnpm dev`，地址为 `http://localhost:3211`。
- 主站页面与路由在 `src/app/`，组件在 `src/components/`，数据与共享逻辑在 `src/lib/`；上报器在 `reporters/`，Cloudflare Workers 在 `workers/`。架构与部署背景查 `README.md`，子项目操作查各自的 README。
- 修改 Next.js 代码前，按上方要求读取本地版本中与改动相关的文档。按需检索，不为小改动遍历整个文档或技能目录。
- 验证覆盖受影响的行为和契约。纯文档改动检查 diff、路径与命令即可；逻辑修复优先跑相关测试；类型或接口改动运行 `pnpm typecheck`；代码规范检查运行 `pnpm exec eslint <改动文件>`；涉及构建、路由或缓存行为时运行 `pnpm build`。UI 改动检查受影响页面的显示与交互。
- 主站完整单测为 `pnpm test`；单文件可用 `node --test --experimental-strip-types --import ./src/lib/testing/register-alias.mjs src/lib/<名称>.test.mts`。上报器和 Worker 使用各自的验证方式。
- 有回归风险时补行为测试；低影响改动不添加仅重复实现的测试。相关检查通过后，只有新改动、失败或未解疑点才扩大或重复验证。环境限制导致无法验证时说明具体缺口。

# 部署流程

- 站点生产部署默认走 Git：完成必要验证后提交改动，执行 `git push origin main`，由已有集成自动部署 Vercel（`lyjw.me`）和 EdgeOne（`lyjw131.com`）。用户要求部署站点时，包含完成这次提交与推送，无需再逐步确认。
- 除非用户明确要求手工部署，不运行 `vercel deploy`、`vercel --prod`、`vercel promote` 等手工发布命令；自动部署失败时先检查并修复现有流程。
- 推送成功不等于部署完成：检查该次提交在两平台的部署状态，并从两个生产域名验证本次受影响的行为或配置。
- NAS 上报器与其他独立部署单元按各自 README 发布。若依赖站点的新契约或更长陈旧窗口，先确认两份站点已生效，再切换上报器，最后验证真实上报与站点读取。

# API 命名与跨端契约

这些约定由主站、`reporters/` 下的相关上报器、MacTelemetryHub 和 Home Assistant 共用。
新增或修改端点、字段前，先定位对应的数据生产者、接收端、消费者和推送事件。

## 入口与字段

| 对象 | 约定 | 示例 / 边界 |
| --- | --- | --- |
| 上报入口 | `/api/ingest/<来源>`，来源按数据归属命名，不使用上报程序名；站点路由和 `workers/ingest` 同路径、同处理器，Vercel 那份只由 Worker 接 | 当前来源：`mac`、`iphone`、`homepod`、`emby`、`playstation`、`server`、`agents` |
| 设备遥测 | 一台设备一个入口、一个信封、一个 `modules` 字典 | 充电头归观测它的 `mac`；活动圆环归搬运和观测它的 `iphone`，不按品牌或模块另开入口 |
| 账号限额 | coding agent 的账号套餐和限额统一归 `agents` | 厂商账号事实不归某台 Mac，也不按采集容器命名 |
| 上报器取数据 | 使用所属 ingest 路径的 GET，沿用相同鉴权 | 若返回凭据，`TELEMETRY_INGEST_SECRET` 就具有获取该凭据的权限，按同等敏感度处理 |
| 状态查询 | `/api/status/X` 表示列表 / 历史，`/api/status/X/now` 表示此刻 | `listening` + `listening/now`，`watching` + `watching/now`；两者同时存在时成对命名 |
| 推送事件 | 跟随状态 URL，`/` 替换为 `-` | 列表为 `X`，此刻为 `X-now`；事件和端点含义一致 |
| 大小写 | URL 段全小写，JSON 字段 camelCase | `/api/status/vibecoding` 与模块 `vibeCoding` 各守其约定 |
| 跨来源字段 | 同一概念必须同名、同单位 | Mac / HomePod 的 `LocalNowPlaying` 共用 `positionMs`、`durationMs`、`repeatOne`、`observedAt`；`observedAt` 为 epoch 毫秒，秒转毫秒在上报侧完成 |
| 图片键 | R2 内容地址使用 `objectKey`，来源侧键用明确名称 | `imageKey`、`iconHash`，避免含义不明的 `key` |

## 变更完成条件

- 重命名直接替换，不接受旧字段、不保留旧路由或兼容分支。
- 同步更新所有受影响的生产者、接收端、消费者、推送事件、测试和文档；按实际调用链确定范围。
- 跨仓库改动在已授权且可访问的范围内完成。外部配置或部署尚未同步时，列出具体对象和待办，不能把站点单侧修改报告成迁移完成。

# 图标与图片

## 选型

- 新增品牌 / 产品图标先查 [LobeHub 图标集](https://lobehub.com/icons)，优先 SVG。静态包地址为 `https://unpkg.com/@lobehub/icons-static-svg@<版本>/icons/<名字>.svg`；单色 `<名字>.svg`、彩色 `<名字>-color.svg`、带字 `<名字>-text.svg`。
- 确认所选版本和文件存在后再引入。只有位图时，先压到展示所需尺寸再入库。
- 含 `fill="currentColor"` 的 SVG 要内联为组件；通过 `<img>` 或 `next/image` 加载时无法继承页面文字色。也可选择颜色写死的彩色版本。现有示例见 `src/components/` 下的 `vibecoding-card.tsx`。

## 加载与缓存

- 静态图标使用 `next/image` 时一律设 `unoptimized`，直接加载最终资源。
- 图片优化器仅用于远端原图比展示尺寸大、且源站无法提供合适尺寸的情况；现有允许列表与原因见 `next.config.ts` 的 `images.remotePatterns`。
- 不在每个请求中重复压图。允许按不可变内容地址压缩一次并缓存：`src/lib/desktop-icon-inline.ts` 按 `objectKey` 压缩 R2 原件、内联首屏，并用 `cacheLife("max")` 缓存；浏览器运行时直连 R2 原件，站点不代理图片流量。
- GitHub 头像由 `src/lib/github-avatar-icon.ts` 在构建期缩小并内联为 data URI；图片优化器中的 GitHub 域名仅供源图获取失败时回退。
