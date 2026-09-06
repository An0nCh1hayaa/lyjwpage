import { SERVER_TAG } from "@/lib/live-events";
import { normalizeServer } from "@/lib/server-parse";
import { fanout } from "@ingest/fanout";
import { mirror } from "@shared/server";

/**
 * 每封都落库：这份快照本身就是心跳，不刷新 receivedAt 的话读那侧永远判不出
 * 上报器是什么时候死的。
 *
 * 不广播。数字每个间隔都在变，推它们等于把推送当轮询用。tag 每次都推，走普通
 * 那半 —— 不推的话 `'use cache'` 里那份快照跟着冻住，卡片 30 秒一轮问到的还是
 * 几分钟前的 CPU。第一次用 urgent：空卡变成有数据，不能再给旧的降级信封顶几分钟。
 */
export async function recordServerReport(input: unknown, receivedAt = Date.now()) {
  const status = normalizeServer(input);
  const previous = await mirror.get();
  const first = previous == null;

  await fanout({
    writes: [mirror.put({ status, receivedAt })],
    tags: first ? [] : [SERVER_TAG],
    urgentTags: first ? [SERVER_TAG] : [],
  });

  return { id: status.id };
}
