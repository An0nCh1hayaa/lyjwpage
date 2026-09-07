import type { ListeningItem, ListeningPayload } from "@/lib/types";
import { mirror } from "@shared/apple-music-store";

/** 只比内容，不比拉取时刻 —— 每轮刷新都会重写 fetchedAt，那不该算变化 */
function sameContent(a: ListeningItem[], b: ListeningItem[]) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 收下刚拉回来的一份：先比，写留给 commit。
 *
 * `changed` 是内容变没变，调用方据此决定要不要推给浏览器和失效缓存 —— 大多数轮次
 * 什么都没变，跟着推就成了定时广播。
 *
 * `listening` 就是要推的那整份，和落库那份同源，所以写和推能同时发车（见 fanout
 * 的规则 1）。从前这一步是把刚写进去的东西再读回来，白等一个来回。
 */
export async function prepareRecentlyPlayed(
  items: ListeningItem[],
  fetchedAt = Date.now(),
): Promise<{
  changed: boolean;
  listening: ListeningPayload;
  commit: () => Promise<void>;
}> {
  const previous = await mirror.get();
  const changed = !previous || !sameContent(previous.items, items);

  return {
    changed,
    listening: { items, fetchedAt },
    commit: () => mirror.put({ items, fetchedAt }),
  };
}
