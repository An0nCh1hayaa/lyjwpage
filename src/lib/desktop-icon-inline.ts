import { cacheLife } from "next/cache";
import sharp from "sharp";

import { objectKeyFromAssetUrl } from "@/lib/asset-url";
import { publicAssetUrl } from "@/lib/r2-assets";

/**
 * 桌面卡图标的展示尺寸 ×2。
 *
 * live-desk-card 里那格是 `size-7`（28px），2× 屏要 56 物理像素。改组件尺寸时
 * 这个数要跟着改。
 */
const ICON_PX = 56;

/**
 * 按对象键压一次，结果永久留用。
 *
 * 缓存键只有 objectKey：R2 上那份是内容寻址的（`<sha256>.png`），键相同就意味着
 * 字节相同，压出来的 webp 不可能变。所以 `cacheLife("max")` —— 一个应用的图标
 * 全站压一次就够，之后每份首屏 HTML 都白拿。（`use cache` 的键隐含 build ID，
 * 换部署会重压一次，这是它的机制，不是这里的意图。）
 *
 * 不直接 fetch 传进来的那个 URL，而是拿校验过的 objectKey 重新拼：`iconUrl`
 * 是 SQLite 里的 objectKey 在读取时经 `publicAssetUrl` 拼出来的（见 telemetry），
 * 这里原样倒推回去，值不会变，但取图的地址被钉死在本部署自己的交付域上，
 * 不会因为上游存了个意外的字符串就把服务端 fetch 带去别处。
 *
 * 失败一律返回 null，让调用方回退到远端 `<Image>`，最坏等于内联之前的行为。
 * null 同样会被缓存住：这是有意的 —— 改成抛出去、在缓存外面接，等于每次页面
 * 重新生成都再赌一次超时。
 */
async function inlineDesktopIcon(objectKey: string): Promise<string | null> {
  "use cache";
  cacheLife("max");

  try {
    const url = publicAssetUrl(objectKey);
    if (!url) return null;

    const res = await fetch(url, {
      cache: "force-cache",
      signal: AbortSignal.timeout(8_000),
      headers: { Accept: "image/*" },
    });
    if (!res.ok) throw new Error(`R2 图标 HTTP ${res.status}`);

    const webp = await sharp(new Uint8Array(await res.arrayBuffer()))
      /**
       * `contain` + 全透明底，对齐组件上那个 `object-contain`：非正方的图标
       * 补的是透明边不是黑边（sharp 的 background 默认不透明，必须写 alpha:0），
       * 补完仍是正方形，占位和现在逐像素一致。
       */
      .resize(ICON_PX, ICON_PX, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .webp()
      .toBuffer();

    return `data:image/webp;base64,${webp.toString("base64")}`;
  } catch (error) {
    console.error(
      "[desktop-icon] 内联失败，回退远端",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

/**
 * 首屏那枚前台应用图标，内联成 data URI 焊进 HTML。
 *
 * 页头是页面最先入眼的一行，图标走远端意味着「HTML 先到、图标后到」，顶部空一格。
 * 内联掉首屏这一跳；**运行时不变** —— 挂载之后换应用、推送进来的新图标，浏览器
 * 照旧直连 R2 原件，站点不代理图片流量。
 *
 * 这层壳子不带 `use cache`：它只做一次正则校验（`objectKeyFromAssetUrl` 认
 * 64 位十六进制 + 后缀），把可缓存的那半交给 `inlineDesktopIcon`，缓存键因此
 * 是干净的 objectKey，而不是带交付域的整条 URL。
 */
export async function desktopIconDataUri(iconUrl: string | null): Promise<string | null> {
  const objectKey = iconUrl ? objectKeyFromAssetUrl(iconUrl) : null;
  return objectKey ? inlineDesktopIcon(objectKey) : null;
}
