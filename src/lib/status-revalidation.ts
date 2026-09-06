import { revalidateTag } from "next/cache";
import { statusCacheTag } from "@/lib/status-cache-scope";

/** Worker 写入完成后调用：首屏后台刷新，urgent API 立即失效。 */
export async function expireStatusTags(
  tags: readonly string[],
  urgentTags: readonly string[],
): Promise<void> {
  for (const tag of tags) {
    revalidateTag(statusCacheTag("page", tag), "max");
    revalidateTag(statusCacheTag("api", tag), "max");
  }
  for (const tag of urgentTags) {
    revalidateTag(statusCacheTag("page", tag), "max");
    revalidateTag(statusCacheTag("api", tag), { expire: 0 });
  }
}
