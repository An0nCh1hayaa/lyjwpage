import type { LiveEvent } from "@/lib/live-events";
import { afterResponse, expireStatusTags, publish } from "./live-platform";
export type PendingEvent = LiveEvent | null | Promise<LiveEvent | null>;
export type Fanout = {
  writes?: ReadonlyArray<Promise<unknown>>;
  events?: ReadonlyArray<PendingEvent>;
  notify?: ReadonlyArray<PendingEvent>;
  tags?: readonly string[];
};
async function publishPending(pending: PendingEvent): Promise<void> {
  try { const event = await pending; if (event) await publish(event); }
  catch (error) { console.error("[live]", error); }
}
/** 确认落库后才响应成功；广播与首屏 stale 通知在后台完成。 */
export async function fanout({ writes = [], events = [], notify = [], tags = [] }: Fanout): Promise<void> {
  await Promise.all(writes);
  await afterResponse(async () => {
    await Promise.all([...events, ...notify].map(publishPending));
    if (tags.length) await expireStatusTags([...new Set(tags)]);
  });
}
