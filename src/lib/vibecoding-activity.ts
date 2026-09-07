"use client";

import { backendUrl } from "@/lib/backend-url";
import type { StatusResponse, VibeCodingNowPayload, VibeCodingPayload } from "@/lib/types";

/**
 * 「此刻」那条推送只带三个字段，得并进手上已有的整份。
 *
 * 模块级单例是为了让推送回调和轮询看到同一份。整张卡只有一张，不会串。
 */

let latest: VibeCodingPayload | null = null;

/** 用首屏 SSR 的完整快照初始化，让挂载后的推送能并进已有的用量。 */
export function seedVibeCoding(payload: VibeCodingPayload): void {
  if (latest) return;
  latest = payload;
}

export async function fetchVibeCoding(
  path: string,
): Promise<StatusResponse<VibeCodingPayload>> {
  const response = await fetch(backendUrl(path), { cache: "no-store" });
  if (!response.ok) throw new Error(`请求 ${path} 失败：${response.status}`);
  const envelope = (await response.json()) as StatusResponse<VibeCodingPayload>;
  if (envelope.ok) latest = envelope.data;
  return envelope;
}

/**
 * 把「此刻」那份补丁盖进手上的整份。还没有整份（首屏没种上）就返回 null，
 * 调用方别把空卡片写进 SWR。
 *
 * 只碰三个字段。会话总数不在这条里 —— 它是累计量，跟着十几分钟一份的用量走。
 */
export function applyVibeCodingNow(patch: VibeCodingNowPayload): VibeCodingPayload | null {
  if (!latest) return null;
  const byId = new Map(patch.agents.map((row) => [row.id, row]));
  latest = {
    ...latest,
    agents: latest.agents.map((agent) => {
      const live = byId.get(agent.id);
      if (!live) return agent;
      return {
        ...agent,
        currentModel: live.currentModel ?? agent.currentModel,
        lastActivityAt: live.lastActivityAt,
        active: live.active,
      };
    }),
  };
  return latest;
}
