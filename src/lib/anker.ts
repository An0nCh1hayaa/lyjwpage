import { AwaitingReport } from "@/lib/awaiting-report";
import { getStored, lastPushReceivedAt } from "@/lib/charger-store";
import { CHARGER_STALE_MS, heartbeatWindowMs } from "@/lib/freshness";
import { publicAssetUrl } from "@/lib/r2-assets";
import {
  offlineByLiveness,
  readLiveness,
  withPresence,
  type Liveness,
} from "@/lib/reporter-liveness";
import type { ChargerPayload, ChargerStatus } from "@/lib/types";

/**
 * Anker Prime 160W (A2687) 遥测。
 *
 * 远端数据只有一条来路：Mac 上报器把 BLE 解出来的充电头放进
 * `chargingDevices` 列表，本站按 `kind` 挑。本机浏览时打开 `/local/charging`
 * 才会直连 `http://127.0.0.1:8787/sse/charger`，见 lib/local-charging。
 */

/**
 * 默认 90 秒；上报间隔配得更长时按 3 倍加长，不能短于默认。
 *
 * **也不能短于心跳窗口。** 续 `pushedAt` 的不只是充电头快照 —— 任何一封把
 * charger 列进 activeModules 的信封都会续（纯心跳走 charger-store 的
 * prepareHeartbeat）。所以「多久没续上」的下限不是充电头的上报间隔，而是心跳
 * 间隔：安静时段没有新读数可发，唯一在续它的就是那条空心跳。
 *
 * 心跳从 30 秒放宽到 90 秒之前这一条不成立也无所谓 —— 30 秒续一次、窗口 90 秒，
 * `pushedAt` 这个判据在 Mac 活着时永远踩不到。放宽之后两者一样长，心跳但凡晚
 * 一点点就越界，卡片会在安静时段闪回「充电器未连接」。上报器整个死掉那种情况
 * 本来就由上面的 offlineByLiveness 管，不靠这一条。
 */
export function chargerStaleAfterMs() {
  const interval = Number(process.env.CHARGER_PUSH_INTERVAL_MS) || 30_000;
  return Math.max(CHARGER_STALE_MS, interval * 3, heartbeatWindowMs());
}

/**
 * 和 main 同一套收卡口径：上报器离线或充电头自己太久没推，就把 connected
 * 打成 false。卡片只看这个字段，不在浏览器再算一遍过期。
 *
 * 快照里留 Redis 原样的 connected；过期是时间函数，在取数出口现盖
 * （首页填缓存、API overlay、推送），不要写进 cachedChargerSnapshot。
 */
export function withChargerFreshness(
  payload: ChargerPayload,
  now = Date.now(),
): ChargerPayload {
  const stale =
    offlineByLiveness(payload, now) || now - payload.pushedAt > payload.staleAfterMs;
  return {
    ...payload,
    connected: stale ? false : payload.connected,
  };
}

/** 对象键入库，公开地址到取数出口才按当前部署拼。 */
function withCoverIconUrl<T extends { cover: ChargerStatus["cover"] }>(payload: T): T {
  const cover = payload.cover;
  if (!cover) return payload;
  const iconUrl = cover.iconObjectKey ? publicAssetUrl(cover.iconObjectKey) : null;
  if (cover.iconUrl === iconUrl) return payload;
  return { ...payload, cover: { ...cover, iconUrl } };
}

/**
 * `since` 是客户端已有的最新采样点时刻，只回传比它更新的部分。
 *
 * 曲线有 400 个点、约 15KB，而前端 30 秒取一次、每次实际只多出一两个点 ——
 * 整份重传的话 99% 是重复数据。
 *
 * 快照只盖时间戳、不改 connected。过期收卡见 withChargerFreshness。
 */
export async function getChargerSnapshot(): Promise<ChargerPayload> {
  const stored = await getStored();
  // 还没收到过任何推送。交给 statusRoute 变成降级信封，前端显示提示
  if (!stored) throw new AwaitingReport("尚未收到充电头遥测推送");

  const [pushedAt, live] = await Promise.all([lastPushReceivedAt(), readLiveness()]);

  return withPresence(
    withCoverIconUrl({
      ...stored.status,
      history: stored.history,
      historyPartial: false,
      pushedAt,
      staleAfterMs: chargerStaleAfterMs(),
    }),
    live,
  );
}

/** 按客户端游标切历史。不重读 Redis，给缓存命中之后的增量路径用。 */
export function sliceChargerHistory(payload: ChargerPayload, since?: number): ChargerPayload {
  const all = payload.history;
  const oldest = all[0]?.t;
  /**
   * 只有「客户端手上最新的点」不早于「服务端还留着的最旧的点」时，增量才是
   * 连续的。客户端离开太久的话中间那段已经被裁掉了，拼出来会是断的曲线，
   * 这种情况只能整份重发。
   */
  const historyPartial = since != null && oldest != null && since >= oldest;
  return {
    ...payload,
    history: historyPartial ? all.filter((sample) => sample.t > since) : all,
    historyPartial,
  };
}

/**
 * 插拔时推给浏览器的那一份，全部拿手上现成的东西拼，一次 Redis 都不读。
 *
 * 从前这里是 `getChargerPayload({ since: Date.now() })`：为了得到一份「不带历史
 * 点的增量」，先要把整条 400 点曲线读回来，再让 sliceChargerHistory 原样丢掉 ——
 * 三次往返换一个空数组。更要命的是它读的是这次上报刚写的那个键，于是推送只能
 * 排在写库后面。而这三样其实都在手上：状态是刚收到的，pushedAt 就是收到的时刻，
 * 曲线只需要知道服务端那边还有没有点。
 *
 * `historyCount` 为 0 时发的是整份（空的）快照，让客户端把自己那条也清掉 ——
 * 服务端手上什么都没有时，客户端不该继续画一条谁也对不上的曲线。
 */
export function chargerPushPayload({
  status,
  receivedAt,
  historyCount,
  liveness,
}: {
  status: ChargerStatus;
  receivedAt: number;
  historyCount: number;
  liveness: Liveness;
}): ChargerPayload {
  return withChargerFreshness(
    withPresence(
      withCoverIconUrl({
        ...status,
        history: [],
        historyPartial: historyCount > 0,
        pushedAt: receivedAt,
        staleAfterMs: chargerStaleAfterMs(),
      }),
      liveness,
    ),
  );
}
