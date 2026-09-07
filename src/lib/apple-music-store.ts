import { AwaitingReport } from "@/lib/awaiting-report";
import type { ListeningPayload } from "@/lib/types";
import { mirror } from "@shared/apple-music-store";

/**
 * 取「最近在听」。
 *
 * 一次都还没拉到过时明确报错，不返回空列表 —— 空列表的意思是「你最近什么都没听」，
 * 而这里的实情是「站点手上还没有这份数据」，两件事的修法完全不同。这个状态是
 * 正常的、短暂的：SQLite 空着的第一个访客会看到它，他自己那次
 * `/api/status/listening/now` 轮询就会把列表拉回来，推送随即把卡片点亮。
 */
export async function getRecentlyPlayed(): Promise<ListeningPayload> {
  const state = await mirror.get();
  if (!state) {
    if (await mirror.reachable()) {
      throw new AwaitingReport("还没有拉到过 Apple Music 最近播放");
    }
    throw new Error("读不到「最近在听」—— Storage 连不上，数据本身可能还在");
  }
  return { items: state.items, fetchedAt: state.fetchedAt };
}
