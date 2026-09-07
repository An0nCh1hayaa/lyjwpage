import { readStatus } from "@/lib/api";
import { pickNowListening } from "@/lib/now-listening";
import { readLiveness } from "@/lib/reporter-liveness";
import { listeningStatus, nowListeningStatus } from "@/lib/status-sources";
import type { ListeningPayload, NowListeningPayload } from "@/lib/types";

/**
 * 「此刻在播」—— 给歌词、动态封面这两条按需端点用的那份。
 *
 * 必须和 `/api/status/listening/now` 读**同一份、同一种取法**：readStatus 按
 * STATUS_CACHE 选冻的还是直读，选 hero 也是 pickNowListening 那一套（存活、暂停
 * 宽限、HomePod 静默都在这一步现算）。浏览器是从那条端点知道此刻是哪首、再来
 * 这两条端点要歌词和封面的；这边要是走另一路，国内那份部署上就会出现「那边已经
 * 是新歌、这边还是 10 分钟前的」，响应里的 songId / link 对不上号，浏览器只能
 * 一直等。
 *
 * 单拆一个文件而不放进 lib/now-listening：那边是纯函数，被 lib/status-cache
 * 引用；这边要反过来引 status-cache，放一起就是循环引用。
 */
export async function readNowListening(): Promise<NowListeningPayload | null> {
  const [envelope, liveness] = await Promise.all([
    readStatus(nowListeningStatus),
    readLiveness(),
  ]);
  if (!envelope.ok) return null;
  return pickNowListening(envelope.data, liveness);
}

/**
 * 卡片 hero 此刻挂的那条 Apple Music 链接 —— 动态封面按它取。
 *
 * 和 listening-card 选 hero 的规则一致：有本机在播的那首就是它的链接（目录解析
 * 出来的 `link`）；没在播时 hero 退回「最近在听」列表的第一条，链接跟着退回
 * `items[0].link`。服务端不做这层回退的话，闲置时浏览器拿列表第一条来对号、
 * 这边却答 null，永远对不上，浏览器每 5 秒白问一次，闲置 hero 也丢了原本有的
 * 动态封面。列表快照同样走 readStatus，和 `/api/status/listening` 同一份。
 */
export async function readHeroLink(): Promise<string | null> {
  const now = await readNowListening();
  if (now && !now.idle) return now.link;
  const list = await readStatus<ListeningPayload>(listeningStatus);
  if (!list.ok) return null;
  return list.data.items[0]?.link ?? null;
}
