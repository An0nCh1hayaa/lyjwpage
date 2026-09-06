import { assetUrl } from "@/lib/asset-url";

import { currentContext } from "./runtime";

export { IMAGE_OBJECT_KEY } from "@/lib/asset-url";

/**
 * `@/lib/r2-assets` 的 Worker 版：站点那份走 S3 协议 HEAD，这里直接用 R2 绑定。
 *
 * 桶由两份部署共用；这里只检查对象，回执中的本侧映射仍由共享 store 判断。
 */

export function publicAssetUrl(objectKey: string): string | null {
  const base = process.env.R2_PUBLIC_BASE_URL;
  return base ? assetUrl(base, objectKey) : null;
}

/** HEAD 结果只记 5 分钟：桶被清空后要能重新发现对象没了，否则会一直发指向已删对象的地址 */
const CONFIRMED_TTL_MS = 5 * 60_000;
const confirmed = new Map<string, number>();

export async function hasStoredImage(objectKey: string): Promise<boolean> {
  const seenAt = confirmed.get(objectKey);
  if (seenAt != null && seenAt > Date.now()) return true;

  try {
    const head = await currentContext().env.IMAGES.head(objectKey);
    if (!head) {
      confirmed.delete(objectKey);
      return false;
    }
    confirmed.set(objectKey, Date.now() + CONFIRMED_TTL_MS);
    return true;
  } catch (error) {
    console.error("[r2]", error instanceof Error ? error.message : String(error));
    confirmed.delete(objectKey);
    return false;
  }
}
