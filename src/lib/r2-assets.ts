import { assetUrl } from "@/lib/asset-url";

export { IMAGE_OBJECT_KEY } from "@/lib/asset-url";

/**
 * 当前部署用来公开读取图片的地址。
 *
 * 名字沿用 R2_PUBLIC_BASE_URL，但它只描述交付层：Vercel 可以填 R2 自定义域，
 * EdgeOne 可以填以 R2 为源站的 COS CDN。Redis 只存 objectKey，所以同一份状态
 * 会在读取时按各自部署的变量拼出不同域名。
 */
export function publicAssetUrl(objectKey: string): string | null {
  const base = process.env.R2_PUBLIC_BASE_URL;
  return base ? assetUrl(base, objectKey) : null;
}
