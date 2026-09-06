import { mirrorKey } from "@/lib/redis";
import {
  type StoredAgentLimits
} from "@/lib/vibecoding-limits";
import {
  type ParsedVibeCodingNow,
  type ParsedVibeCodingUsage
} from "@/lib/vibecoding-parse";

/**
 * 三份存储，按**谁产生、多久变一次**分。
 *
 * - `now`：此刻在不在用、用的是哪个模型。Mac 报，60 秒一轮，变了就推给浏览器。
 * - `usage`：token、费用、会话总数 —— 全是累计事实，Mac 报，十几分钟才动一次，
 *   只失效首屏缓存，不推送。
 * - `limits`：各 agent 账号侧的套餐与用量窗口。**容器上报器**走 `/api/ingest/agents`
 *   报，几分钟一轮、每轮必发。从前它搭 usage 的车，Mac 合盖就冻住；限额是厂商
 *   账号的事实，跟那台 Mac 无关，所以拆出去在 NAS 上 24 小时跑。
 *
 * 从前 usage 和 limits 是一份，再往前是三份（按「哪条命令产出的」划）。现在这道
 * 线是按来源划的：两台机器各报各的，站点按 id 拼成一行。
 *
 * Redis 为主、进程内存为辅，规则见 lib/redis 的 mirrorKey。
 */
export const usageMirror = mirrorKey<{ payload: StoredUsage; pushedAt: number }>(
  ["vibecoding", "usage"],
  (state) => state.pushedAt,
);

export const nowMirror = mirrorKey<{ payload: StoredNow; pushedAt: number }>(
  ["vibecoding", "now"],
  (state) => state.pushedAt,
);

export const limitsMirror = mirrorKey<StoredAgentLimits>(
  ["vibecoding", "limits"],
  (state) => state.pushedAt,
);

/** 长间隔那份：一次采集里所有的累计量。展示名和图标跟着行走，读的时候原样取出。 */
export type StoredUsage = ParsedVibeCodingUsage;

/** 短间隔那份：此刻的状态，没有任何累计量。 */
export type StoredNow = ParsedVibeCodingNow;
