import { assetUrl } from "@/lib/asset-url";

export { IMAGE_OBJECT_KEY } from "@/lib/asset-url";

/**
 * 当前部署用来公开读取图片的地址。
 *
 * R2_PUBLIC_BASE_URL 指向图片交付域。SQLite 只存 objectKey，
 * 读取时使用部署配置拼出公开地址。
 */
export function publicAssetUrl(objectKey: string): string | null {
  const base = process.env.R2_PUBLIC_BASE_URL;
  return base ? assetUrl(base, objectKey) : null;
}
