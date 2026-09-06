import { CHARGER_HISTORY_LIMIT } from "@/lib/limits";
import { tellRedis, withRedis } from "@/lib/redis";
import type { ChargerSample, ChargerStatus } from "@/lib/types";
import { type ChargerLanding, type ChargerState, DISCONNECTED_HISTORY_AFTER_MS, K_HISTORY, K_LAST_PUSH, K_LATEST, type Stored, disconnectedHistoryExpired, fallback } from "@shared/charger-store";

/**
 * 充电头状态与总功率历史。
 *
 * 数据是「推」进来的：那台机器周期性把 a2687 的 /status 原样 POST 过来。
 * 间隔以秒计，光靠客户端自己累积的话页面一刷新曲线就没了、还要攒很久
 * 才有形状 —— 所以历史必须存在服务端。
 *
 * 存 Redis：进程重启后历史还在。没配 Redis 就退回进程内存。
 */

/**
 * 两个采样点之间的最小间隔，用来控制曲线的时间跨度。
 *
 * 采集端本身是 1 Hz，但上报按上报器的节流窗口走（代码默认 10 秒，本机配的是
 * 30 秒），所以到这里的间隔由
 * 上报间隔决定、通常已经大于这个阈值 —— 它真正拦的是即时上报：插拔、播放
 * 变化会把充电器快照顺带捎出去，那些不该在曲线上挤成一团。
 * 要拉长曲线跨度就调大它，或者调 CHARGER_HISTORY_LIMIT。
 */
const MIN_SAMPLE_GAP_MS = 5_000;

/** 历史和快照的保留时长，比断流阈值宽松得多，重启后仍能接上 */
const TTL_MS = 24 * 60 * 60 * 1000;

/** 这一帧对曲线做什么。算好再一次性写下去，别读一次写一次 */
type HistoryPlan =
  | { kind: "keep" }
  | { kind: "clear" }
  /** `reset` 为真时先清空：断联太久重新起步，或者对端时钟倒流、旧曲线接不上了 */
  | { kind: "append"; sample: ChargerSample; reset: boolean };

/**
 * 「需要即时通知」的指纹：插拔、换设备、换充电器，以及卡片显隐边界。
 *
 * `active` 来自充电头给的端口开关位，不是从功率推的 —— 插着线不取电的口是
 * 开 + 0.00W，所以它能认出「插上了但还没开始充」，比设备名灵：插一个采集端
 * 表里没有的设备，`device` 是 null，但开关位一定会翻。
 *
 * 原始 `power` / `voltage` / `current` 仍然不进指纹：那三个充电时每帧都在动，
 * 进来就等于把即时推送打成定时推送。这里只额外记「总功率是否越过 1W」这个
 * 展示边界，因为它直接决定卡片显隐；待机时端口开关可能不变，少了这位就只能
 * 等下一次轮询才能把卡收起来。
 */
function structuralKey(status: ChargerStatus) {
  return JSON.stringify([
    status.connected,
    status.totalPower > 1,
    status.device.serialNumber,
    status.device.firmwareVersion,
    status.ports.map((port) => [port.id, port.active, port.device]),
    status.cover?.name ?? null,
    status.cover?.iconHash ?? null,
  ]);
}

/**
 * 这一帧该往曲线里加什么。同一个 updatedAt 重复推送不会产生重复采样点。
 *
 * `history` 传的是**落库前**服务端手上那条，函数不改它。
 */
function planHistory(
  previous: Stored | null,
  status: ChargerStatus,
  receivedAt: number,
  stored: ChargerSample[],
  resetAfterDisconnect: boolean,
): HistoryPlan {
  // 断联超时后重新起步：旧曲线不属于下一次连接
  const clear = resetAfterDisconnect && stored.length > 0;
  const nothing: HistoryPlan = clear ? { kind: "clear" } : { kind: "keep" };
  // 超时后持续断联的 0W 快照也不再入库
  if (resetAfterDisconnect && !status.connected) return nothing;
  const history = resetAfterDisconnect ? [] : stored;

  // 同一帧被推两次时不重复记。采集端现在是 1 Hz 推流，每帧都会换 updated_at，
  // 所以这道判断只在重试或重复投递时才拦得住东西 —— 留着是因为那才是它的本意。
  if (previous && status.updatedAt != null && previous.status.updatedAt === status.updatedAt) {
    return nothing;
  }

  const last = history[history.length - 1];
  const at = status.updatedAt ?? receivedAt;
  let reset = false;

  if (last) {
    // 顺序很重要：时间倒流时 (at - last.t) 是负数，也会小于 MIN_SAMPLE_GAP_MS。
    // 先判倒流再判间隔，否则重置分支永远走不到，新数据会被一直丢掉。
    if (at < last.t) {
      // 对端改了时钟或换了数据源，旧历史已经没法和新的拼在一条时间轴上
      reset = true;
    } else if (at - last.t < MIN_SAMPLE_GAP_MS) {
      return nothing;
    }
  }

  return { kind: "append", sample: { t: at, w: status.totalPower }, reset: reset || clear };
}

/**
 * 收一条快照：读已经在外面做完了，这里只算，写留给 commit。
 *
 * 从前这是一个 recordStatus，里面读一次写一次读一次写一次，四个来回全压在推送
 * 前面。现在两次读由调用方在信封解析完时和别的键一起发车（readChargerState），
 * 两次写并成一条 pipeline，而且和推送一起发车。
 */
export function prepareStatus(
  status: ChargerStatus,
  receivedAt: number,
  { previous, history }: ChargerState,
): ChargerLanding {
  const previousDisconnectedAt =
    previous && !previous.status.connected
      ? previous.disconnectedAt ?? previous.receivedAt
      : null;
  const disconnectedAt = status.connected ? 0 : previousDisconnectedAt ?? receivedAt;
  const resetAfterDisconnect =
    previousDisconnectedAt != null &&
    receivedAt - previousDisconnectedAt >= DISCONNECTED_HISTORY_AFTER_MS;
  // 第一份快照也算变化：客户端手上还什么都没有，该收到一次
  const structuralChanged =
    !previous || structuralKey(previous.status) !== structuralKey(status);

  const plan = planHistory(previous, status, receivedAt, history, resetAfterDisconnect);

  const kept =
    plan.kind === "keep" ? history.length : plan.kind === "clear" ? 0 : plan.reset ? 0 : history.length;
  const historyCount = Math.min(
    kept + (plan.kind === "append" ? 1 : 0),
    CHARGER_HISTORY_LIMIT,
  );

  return {
    structuralChanged,
    historyCount,
    commit: async () => {
      fallback.latest = status;
      fallback.receivedAt = receivedAt;
      fallback.disconnectedAt = disconnectedAt;
      fallback.lastPushAt = receivedAt;
      if (plan.kind !== "keep") {
        if (plan.kind === "clear" || plan.reset) fallback.history.length = 0;
        if (plan.kind === "append") fallback.history.push(plan.sample);
        if (fallback.history.length > CHARGER_HISTORY_LIMIT) {
          fallback.history.splice(0, fallback.history.length - CHARGER_HISTORY_LIMIT);
        }
      }

      fallback.persisted = await tellRedis(async (redis) => {
        const pipe = redis.pipeline();
        pipe.set(
          K_LATEST,
          JSON.stringify({ status, receivedAt, disconnectedAt: disconnectedAt || null }),
          "PX",
          TTL_MS,
        );
        pipe.set(K_LAST_PUSH, String(receivedAt), "PX", TTL_MS);
        if (plan.kind === "clear" || (plan.kind === "append" && plan.reset)) pipe.del(K_HISTORY);
        if (plan.kind === "append") {
          pipe.rpush(K_HISTORY, JSON.stringify(plan.sample));
          // 只留最近 CHARGER_HISTORY_LIMIT 条，用 Redis 自己的裁剪，不用把整条读回来重写
          pipe.ltrim(K_HISTORY, -CHARGER_HISTORY_LIMIT, -1);
          pipe.pexpire(K_HISTORY, TTL_MS);
        }
        return pipe.exec();
      });
    },
  };
}

/**
 * 没带充电头快照的那种信封（纯心跳）：只续上「最近一次收到推送」的时刻。
 *
 * 断联后即使状态不再变化，心跳仍会走到这里；所以断联满半小时把曲线清空这件事
 * 也挂在它身上，不依赖新的快照。读同样在外面做完了 —— 从前它自己去读一次快照
 * 再读一次曲线，每 30 秒一封的心跳白白多两个来回。
 */
export function prepareHeartbeat(
  receivedAt: number,
  { previous, history }: ChargerState,
): { commit: () => Promise<void> } {
  const expired =
    previous != null &&
    disconnectedHistoryExpired(previous, receivedAt) &&
    history.length > 0;

  return {
    commit: async () => {
      fallback.lastPushAt = receivedAt;
      if (expired) fallback.history.length = 0;
      // 不走 tellRedis：`persisted` 说的是「快照那份落进去了没有」，
      // 这里写的是心跳时刻，不该由它来翻那个标志
      await withRedis(async (redis) => {
        const pipe = redis.pipeline();
        pipe.set(K_LAST_PUSH, String(receivedAt), "PX", TTL_MS);
        if (expired) pipe.del(K_HISTORY);
        return pipe.exec();
      }, null);
    },
  };
}
