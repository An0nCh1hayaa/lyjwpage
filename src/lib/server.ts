import { AwaitingReport } from "@/lib/awaiting-report";
import { isStale, serverStaleMs } from "@/lib/freshness";
import { fanout, SERVER_TAG } from "@/lib/live-events";
import { mirrorKey } from "@/lib/redis";
import { normalizeServer } from "@/lib/server-parse";
import type { ServerPayload, ServerStatus } from "@/lib/types";

/**
 * 日本落地节点的此刻状态。
 *
 * 喂它的是跑在节点上的上报器（`reporters/server-reporter`）：读 `/proc`，把
 * CPU / 内存 / 磁盘 / 网速算完再 POST 过来。站点不 ssh、不轮询那台机器。
 *
 * 这条路上**没有实时推送**。CPU 和网速每个间隔都在变，为它开一路广播就是拿
 * 推送当轮询用 —— 和充电头的滚动读数同一个判断。上报只让首屏那份缓存失效，
 * 卡片按上报间隔自己来问。
 *
 * 心跳就是这份快照本身：上报器每个间隔必发一封，哪怕数字几乎没动。所以
 * 「多久没刷新」等价于「上报器还活着没有」，断流判定在取数出口现算。
 */

export { normalizeServer };

/** 一周。机器重启几天再回来时，卡片该说的是「这是上次那份」，不是「从没收到过」 */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

type StoredServer = {
  status: ServerStatus;
  /** 源站收到的时刻 */
  receivedAt: number;
};

const mirror = mirrorKey<StoredServer>(
  ["server", "host"],
  (state) => state.receivedAt,
  { ttlMs: TTL_MS },
);

export function withServerFreshness(
  payload: ServerPayload,
  now = Date.now(),
): ServerPayload {
  return {
    ...payload,
    staleAtSource: isStale({
      now,
      at: payload.pushedAt,
      windowMs: payload.staleAfterMs,
    }),
  };
}

function toPayload(stored: StoredServer): ServerPayload {
  return withServerFreshness({
    ...stored.status,
    pushedAt: stored.receivedAt,
    staleAfterMs: serverStaleMs(),
    staleAtSource: false,
  });
}

export async function getServerSnapshot(): Promise<ServerPayload> {
  const stored = await mirror.get();
  if (!stored) throw new AwaitingReport("尚未收到落地节点上报");
  return toPayload(stored);
}

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
