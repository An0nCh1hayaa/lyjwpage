import { revalidateTag } from "next/cache";

/** 已落库的展示变化只标记首屏 stale，已有 HTML 始终优先返回。 */
export async function expireStatusTags(tags: readonly string[]): Promise<void> {
  for (const tag of new Set(tags)) revalidateTag(`page:${tag}`, "max");
}
