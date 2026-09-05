import { askRedis, key, tellRedis, withRedis } from "@/lib/redis";

/**
 * 通用 TTL 缓存 + in-flight 去重 + 负缓存。
 *
 * 给还需要本站主动去拉的上游用（Apple Music 目录、GitHub 贡献日历；
 * 其余状态源都是推进来的）：
 * - 同一个 key 并发进来时只会真正打一次上游，其余人等同一个 Promise
 * - 上游报错时短暂缓存错误，避免上游挂掉后被前端轮询打爆
 *
 * 值存在 Redis 里，进程重启和多实例都能共享。没配 Redis 就退回进程内存。
 * in-flight 去重始终是进程内的 —— 它要挡的是同一进程内的并发穿透，
 * 这件事 Redis 代劳不了。
 */

type Entry = {
  value: unknown;
  expiresAt: number;
  /** 这份有没有真的落进 Redis。false 表示它只活在本进程内存里，见 get */
  persisted: boolean;
};

const memory = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

/**
 * 进程内那份副本的条数上限。
 *
 * 过期项只在被命中时才顺手删，没有周期清扫 —— 键是「歌名+歌手+专辑」这种一首歌
 * 一条、TTL 七天的东西，serverless 上有实例寿命兜着，`next start` 那种长驻进程上
 * 却是只增不减。Map 的插入顺序顺便充当 LRU，和 telemetry 的 rememberDesktopIcon
 * 同一套写法。它只是 Redis 不可达时的备份，几百条足够。
 */
const MEMORY_LIMIT = 500;

/** 上游报错后，多久之内不再重试 */
const NEGATIVE_TTL_MS = 5_000;
const NEGATIVE_PREFIX = "neg";

function memoryEntry(k: string): Entry | undefined {
  const hit = memory.get(k);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    memory.delete(k);
    return undefined;
  }
  return hit;
}

function memoryGet<T>(k: string): T | undefined {
  return memoryEntry(k)?.value as T | undefined;
}

function memorySet(k: string, value: unknown, ttlMs: number, persisted: boolean) {
  // 重新插入，让它排到末尾：淘汰的总是最久没被写过的那条
  memory.delete(k);
  memory.set(k, { value, expiresAt: Date.now() + Math.max(1_000, ttlMs), persisted });
  while (memory.size > MEMORY_LIMIT) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
}

/**
 * Redis 答得上话就以它为准，**它说没有就是没有**；只有不可达才退回进程内存。
 *
 * 从前是 `withRedis(get, null)`，「Redis 说 null」和「Redis 连不上」在外面长得
 * 一模一样，都会落到内存副本 —— 于是清空 Redis、或者另一个实例 `remove()` 掉的
 * 值，在本进程里还按原 TTL 活着（Apple 链接那份是 7 天）。mirrorKey 早就为同一
 * 个坑改用 askRedis 了，这里对齐。
 *
 * 唯一的例外是**上次写没落进去**的那条（`persisted` 为假）：SET 被拒（OOM、
 * WRONGTYPE）不触发 error 事件，Redis 仍算可达，那份值却只在本进程内存里。
 * 这时 Redis 说 null 不是「被人删了」而是「从没写进去」，得继续用内存那份 ——
 * 不然 cached() 每次都重跑 loader，5 秒负缓存也一起失灵，恰好在 Redis 不对劲
 * 的时候把上游打得最狠。和 mirrorKey 的 persisted 是同一条规则。
 */
export async function get<T>(k: string): Promise<T | undefined> {
  const answer = await askRedis((redis) => redis.get(key("cache", k)));
  if (!answer.reachable) return memoryGet<T>(k);
  if (answer.value == null) {
    const local = memoryEntry(k);
    return local && !local.persisted ? (local.value as T) : undefined;
  }
  try {
    return JSON.parse(answer.value) as T;
  } catch {
    // 存进去的一定是 JSON，解不出来说明是脏数据，当作没有
    return undefined;
  }
}

export async function put<T>(k: string, value: T, ttlMs: number) {
  // PX 只吃整数：带小数的 TTL（比如按半衰期除出来的 x.5 毫秒）会让 Redis 拒掉
  // 整条 SET，错误再被 withRedis 静默吞掉 —— 值就只活在本进程内存里，
  // 表现成「共享缓存时灵时不灵」。约束在这层收口，不指望每个调用方自己取整。
  const ttl = Math.max(1_000, Math.ceil(ttlMs));
  // 先按「没落进去」写内存：Redis 那一步在飞时并发的 get 也能拿到这份
  memorySet(k, value, ttl, false);
  const persisted = await tellRedis((redis) =>
    redis.set(key("cache", k), JSON.stringify(value), "PX", ttl),
  );
  if (persisted) memorySet(k, value, ttl, true);
}

/**
 * 抢下接下来这段时间的独占：抢到 true，这段时间里别人一律 false。
 *
 * `SET NX PX` 是原子的 —— 这正是 `cached()` 给不了的那半。它的值要等 loader
 * 回来才写，于是**取数的那一两秒里闸门还是空的**，别的实例照样穿过去（它的
 * in-flight 去重只在进程内，挡不住跨实例）。给「按节奏去拉一次上游」这种事
 * 用：先抢，抢到才拉，TTL 到了才轮到下一个。
 *
 * Redis 不可达时返回 true：没有共享闸门可用时，宁可让每个实例各自按自己的节奏
 * 去拉（调用方那道进程内的时刻仍然管着频率），也好过一次都不拉 —— 本地开发
 * 不配 Redis 就是这种情况。
 *
 * 抢到之后失败了不回滚，那一段就是空过：这是有意的，上游正病着的时候不该由
 * 下一个请求立刻再试一次。
 */
export async function claim(k: string, ttlMs: number): Promise<boolean> {
  // PX 只吃整数，理由同上面 put 里那段
  const ttl = Math.max(1_000, Math.ceil(ttlMs));
  return withRedis(
    async (redis) => (await redis.set(key("cache", k), "1", "PX", ttl, "NX")) === "OK",
    true,
  );
}

/**
 * 主动作废一条：内存和 Redis 两层一起删。
 *
 * 给「缓存的值被上游判了死刑」的场景用 —— TTL 还没到、但值已经确认失效
 * （比如动态封面那份扒来的 web token 吃了 401），等它自然过期只会让失效
 * 期间的请求全部陪葬。
 */
export async function remove(k: string) {
  memory.delete(k);
  await withRedis(async (redis) => redis.del(key("cache", k)), null);
}

export async function cached<T>(
  k: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  /**
   * 值和负缓存一起问，不串着问。
   *
   * 命中时那条负缓存的 GET 是白问的 —— 但它和值那条在同一条连接上并发发出、
   * 在网络上重叠，多花的是 Redis 的一点点力气，不是一个来回。没命中时省下的
   * 才是实打实的一个来回，而那正是要紧的时候：换歌那一刻要现查目录，
   * 「此刻在听」的推送就压在这条链路上。
   */
  const [hit, failure] = await Promise.all([
    get<T>(k),
    get<{ message: string }>(`${NEGATIVE_PREFIX}:${k}`),
  ]);
  if (hit !== undefined) return hit;
  if (failure) throw new Error(failure.message);

  const running = inflight.get(k);
  if (running) return running as Promise<T>;

  const promise = (async () => {
    try {
      const value = await loader();
      await put(k, value, ttlMs);
      return value;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await put(`${NEGATIVE_PREFIX}:${k}`, { message: err.message }, NEGATIVE_TTL_MS);
      throw err;
    } finally {
      inflight.delete(k);
    }
  })();

  inflight.set(k, promise);
  return promise;
}
