import type { NextConfig } from "next";
import { execSync } from "node:child_process";

/**
 * 页脚那行构建信息。两个值都必须在**构建期**求值、以字面量内联进产物。
 *
 * 别改成在服务端组件里现算 —— 首页的静态壳不是构建期就冻住的：每次上报进来
 * 都会按 tag 失效，下一个请求在服务端重新生成一遍（见下面 cacheComponents
 * 那段）。在模块作用域写 `new Date()`，拿到的是「最后那台实例的冷启动时刻」，
 * 会跟着上报一整天悄悄往前漂，而且页面上看不出来它是错的。
 *
 * 走 `env` 是因为它是 DefinePlugin 式的文本替换：值在构建时焊死，之后无论
 * 冷启动还是重新生成都不会再变。（这个字段的文档标了 legacy，指的是「读配置」
 * 这个用途该用 .env 文件；.env 算不出值，构建期常量还是只能走这里。）
 */
const BUILD_TIME = new Date().toISOString();

/** Vercel 自动注入完整 sha；本地开发没有这个变量，回退问 git */
function resolveCommitSha(): string {
  const fromVercel = process.env.VERCEL_GIT_COMMIT_SHA;
  if (fromVercel) return fromVercel;
  try {
    return execSync("git rev-parse HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // 拿不到就留空（浅克隆、tarball 部署），页脚那一段整个不显示
    return "";
  }
}

const nextConfig: NextConfig = {
  env: {
    BUILD_TIME,
    COMMIT_SHA: resolveCommitSha(),
  },
  /**
   * 首屏那八份数据走 `use cache` + `cacheTag`，上报进来时按 tag 失效。
   *
   * 开了它之后 `dynamic` / `revalidate` / `fetchCache` **以及 `runtime`** 这几个
   * 段配置一律不能再导出，写了就是构建期报错 —— 官方迁移文档只写了前三个和
   * `runtime = "edge"`，但 `runtime = "nodejs"`（默认值）照样被拒。全站的渲染
   * 意图改由 `use cache` 和 `<Suspense>` 表达：取数缓存见 lib/status-cache，
   * 失效点见 lib/live-events 的 expireStatus（只刷本实例）；八条状态路由也读
   * lib/status-cache，但 STATUS_CACHE=false 的部署上它们改成每次直读 Redis，
   * 见 lib/api。首屏那份不受那个开关管 —— 冻着才有这里说的预渲染。
   */
  cacheComponents: true,
  /**
   * 分享卡片那张图要的两份 ttf（见 app/opengraph-image）。
   *
   * 追踪本来就认得那两个字面量路径，但它记的是 pnpm 仓库里的真身
   * （`node_modules/.pnpm/geist@…/node_modules/geist/…`）—— 函数里没有
   * `node_modules/geist` 那条软链，代码按 `process.cwd()` 拼出来的路径就是
   * ENOENT。这里按**代码实际读的那个路径**再要一次，让字节以真文件落在那儿。
   *
   * 只挂 `/opengraph-image` 一条：那张图 `cacheLife("max")`，30 天后仍会在运行时
   * 重画一次，字体必须在函数里；首屏不读字体，别让它多背 300KB。
   */
  outputFileTracingIncludes: {
    "/opengraph-image": [
      "node_modules/geist/dist/fonts/geist-mono/GeistMono-Regular.ttf",
      "node_modules/geist/dist/fonts/geist-mono/GeistMono-Bold.ttf",
    ],
  },
  allowedDevOrigins: ["test.lyjw.dev", "127.0.0.1"],
  images: {
    /**
     * 只有「源图比展示格大、源站又缩不了」才放行优化器。
     *
     * 自建歌单封面：Apple blobstore 上的原图（实测 274KB PNG，没有 {w}x{h}），
     * 页面上那格只有 80px。host 用通配是因为散在 store-030 ~ store-037。
     *
     * GitHub 头像：**只作回退**。主路径是构建期把它缩到 128px webp、内联成
     * data URI 焊进首屏 HTML（见 lib/github-avatar-icon），页面顶部那张脸不该
     * 等第二趟网络请求。构建时拉不到源图才落到这条上，过优化器缩整图 JPEG。
     *
     * PlayStation 头像：psn-rsc 只有 _s(50) / _m(160) / _l(240) / _xl(440) 这一档
     * 路径后缀，提要里那格 40px、3× 要 120，够得着的最小一档是 160px 的 PNG（52KB），
     * 直连比过优化器（约 4KB）贵十倍 —— 它是 PSN 三个主机里唯一缩不到位的，所以
     * 只剩它还在这张名单上。Redis 仍只存上游 URL，不落 R2。
     *
     * 封面和奖杯图都不在此列：那两个主机自己认 `?w=&h=`（还会把热起来的尺寸
     * 转成 AVIF），改走源站现缩 + 直连，见 lib/playstation-image。
     *
     * 其余一律不走：R2 已经是压好的最终尺寸且 immutable，mzstatic 自带尺寸
     * 模板，再转一道是纯浪费。
     *
     * pathname 只能写 `/**`：`**` 匹配的是完整路径段，段内通配不成立。
     * search 省略等于放行任意查询串（预签名必须带 X-Amz-*，头像带 s=）。
     */
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.blobstore.apple.com",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "avatars.githubusercontent.com",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "psn-rsc.prod.dl.playstation.net",
        pathname: "/**",
      },
    ],
    /**
     * 仅供「自建部署 + 本机走 fake-IP 代理」这一种情况。
     *
     * Clash/Surge 那类代理在 TUN 模式下把域名解析到 198.18.0.0/15，而 Next 16
     * 的 SSRF 防护看到私有 IP 就拒绝取图（实测：hostname resolved to private
     * IP 198.18.8.12，连问 1.1.1.1 都是这个结果，是网络层劫持不是本机 DNS）。
     *
     * 默认关，Vercel 上不要设 —— 那边解析得到真实公网 IP，开了纯属白白削弱
     * SSRF 防护。真正干净的解法是在代理里给 blobstore.apple.com 配直连规则，
     * 这个开关只是不想让部署被代理配置卡住。
     */
    dangerouslyAllowLocalIP: process.env.IMAGE_ALLOW_LOCAL_IP === "true",
  },
};

export default nextConfig;
