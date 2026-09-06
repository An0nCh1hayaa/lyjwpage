import { AwaitingReport } from "@/lib/awaiting-report";
import { isStale, playstationStaleMs } from "@/lib/freshness";
import { getPlaystationPlayedGames, getPlaystationPresence } from "@/lib/playstation-store";
import type {
  PlaystationPlayingPayload,
  PlaystationPresencePayload
} from "@/lib/types";

export async function getPlaying(): Promise<PlaystationPlayingPayload> {
  const payload = await getPlaystationPlayedGames();
  if (!payload) throw new AwaitingReport("尚未收到 PlayStation 最近游玩遥测");
  return payload;
}

export async function getPlayingNow(): Promise<PlaystationPresencePayload> {
  const payload = await getPlaystationPresence();
  if (!payload) throw new AwaitingReport("尚未收到 PlayStation 在线状态遥测");
  return payload;
}

/**
 * presence 是心跳：Worker 每轮 cron 都发一封，内容没变也发。于是「observedAt
 * 多久没动」就是「Worker 还活着没有」，而这个判定光靠时间流逝就会翻面 ——
 * 所以它在**读的出口每次请求现算**，不进 'use cache'。冻进快照的话 Worker
 * 死掉之后页面会一直举着「正在游玩」，快照 TTL 还有 30 天。
 *
 * 断流不等于离线：Worker 死了我们只是**不知道**他在不在玩。所以退成
 * AwaitingReport 交给 statusRoute 发降级信封，卡片照旧摆最近在玩的瓷砖、
 * 只是不再有「正在游玩」那一行 —— 而不是伪造一个 online:false 说他下线了。
 */
export function assertPresenceFresh(
  payload: PlaystationPresencePayload,
  now = Date.now(),
): PlaystationPresencePayload {
  if (!isStale({ now, at: payload.observedAt, windowMs: playstationStaleMs() })) {
    return payload;
  }
  const minutes = Math.round(Math.max(0, now - payload.observedAt) / 60_000);
  throw new AwaitingReport(`PlayStation 在线状态遥测断流：最后一次采集在 ${minutes} 分钟前`);
}
export { normalizePlaystationPlayedGames, normalizePlaystationPresence } from "@shared/playstation";
