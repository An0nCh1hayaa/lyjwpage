/**
 * PSN 图床的现缩参数。
 *
 * 两个图床都认 `?w=&h=`：1024² 的封面要 336² 只回 25KB（浏览器带
 * `Accept: image/avif` 时它自己就编码成 AVIF），不带参数回的是 240KB 的原图。
 * 既然源站缩得动，按 AGENTS.md 那条规矩这一路就不进站点的图片管道 —— 绕回
 * `/_next/image` 只是多一次转码、多一份配额，还把本可以直连 CDN 的请求拽回
 * 自己的函数。
 *
 * 奖杯图标（psnobj 的杯面原画）刻意**不**经这个函数：它的缩图档全是狠压缩
 * JPEG（84² 只有 4.5KB、168² 9KB，原图 512² / 57KB 才是唯一的高质量档），
 * 细节密的原画在小档上糊得可见。那几处直接用原图 URL，浏览器一次降采样
 * 到位 —— 奖杯图总量小、明细行又是懒加载，字节代价可控（见 trophy-teaser、
 * trophy-details）。
 *
 * 头像那个 psn-rsc 不认这两个参数（原样回 440² PNG），所以按主机名放行，
 * 认不出的原样返回。
 *
 * 只收一个正方边长：游玩列表和 presence 给的都是方形图标（实测 1024² / 512²），
 * 卡片上那一格也是方的。w 和 h 必须一起给 —— 只给 w 的话 CDN 会往上取到它
 * 自己那档预设尺寸（要 336 回 370），不是要的那个数。
 */
const SIZED_HOSTS = new Set([
  "image.api.playstation.com",
  "psnobj.prod.dl.playstation.net",
]);

export function playstationImage(
  url: string | null | undefined,
  size: number,
): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  // 判主机名而不是找子串，理由同 apple-artwork 的 needsOptimizing
  if (!SIZED_HOSTS.has(parsed.hostname)) return url;
  const dimension = String(Math.max(1, Math.round(size)));
  parsed.searchParams.set("w", dimension);
  parsed.searchParams.set("h", dimension);
  return parsed.toString();
}

/**
 * PSN 那几路图一律按 3 倍取，理由和 apple-artwork 的 ARTWORK_SCALE 一样：
 * 手机常见 3× DPR，2 倍图会被浏览器再放大一截而发虚。
 *
 * 直连那几路是拿它拼 `?w=&h=`；头像那路虽然走图片管道，取图目标也按它定
 *（报给 next/image 的是一半，好让 2x 那档正好落在 3 倍上，见 trophy-teaser）。
 *
 * 另一半理由是「差一点」比「差很多」还糊：从前那张交给优化器的 256px 图，
 * 落到 2× 屏上那格 224 个设备像素，浏览器还要再重采样一道 256 → 224，
 * 细节就是在这一步被抹掉的。现在按设备像素整数倍取，缩放只发生一次。
 */
export const PLAYSTATION_IMAGE_SCALE = 3;

