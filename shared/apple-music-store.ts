import { mirrorKey } from "@/lib/redis";
import type { ListeningItem } from "@/lib/types";

/**
 * 「最近在听」的落库。
 *
 * **一个键装整份**，所以访客读它只有一次 Redis（命中 `'use cache'` 时连这一次
 * 都没有）。曾经每个 item 各走一次缓存，十项就是十个来回 —— 那是当初把这件事
 * 搬去常驻上报器的理由之一，形状换成这样之后那笔开销就不在了，和进不进程无关。
 *
 * Redis 为主、进程内存为辅，规则见 lib/redis 的 mirrorKey。
 */

/**
 * `fetchedAt` 单独放在外面，它是代数不是新鲜度 —— 这张卡没有陈旧判定
 * （一份冻住的「最近在听」本身没有错），用处见 ListeningPayload。
 *
 * **键里带格式版本。** 这个值的形状变过一次（上报器时代是
 * `{ payload: { items, nowPlaying }, pushedAt }`），而 mirrorKey 只 JSON.parse、
 * 不校验形状 —— 键不跟着换的话旧条目会被当成新格式读，`items` 就是 undefined，
 * 而首屏那句 `listening.data.items.map` 会把**整页预渲染**打挂（信封仍是
 * `ok: true`，所以没有任何一层会兜住它）。2026-08-29 在 Vercel 上就是这么挂的：
 * 本地 build 全绿，因为本地那个 Redis 里根本没有旧值。
 *
 * 以后再改这个值的形状，记得一起改版本号 —— 和 lib/apple-music 里那条
 * track-lookup 缓存键同一条规矩，那次的症状是链接和封面一起消失，这次是整页。
 */
export const mirror = mirrorKey<{ items: ListeningItem[]; fetchedAt: number }>(
  ["apple-music", "recent", "v2"],
  (state) => state.fetchedAt,
);
