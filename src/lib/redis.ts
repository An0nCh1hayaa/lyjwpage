import {
  askRedis,
  key,
  resetRedisDriverForTests,
  tellRedis,
  type RedisClient,
  type RedisPipeline,
} from "@/lib/redis-driver";

/**
 * Redis 上的两种镜像（单键、字段级）。连接本身在 lib/redis-driver：Node 上是 ioredis，
 * workers/ingest 里换成 cloudflare:sockets 的实现，这个文件两边共用。
 */
export {
  askRedis,
  getRedis,
  installRedisForTests,
  key,
  tellRedis,
  withRedis,
  withRedisScope,
  type RedisAnswer,
  type RedisClient,
  type RedisPipeline,
} from "@/lib/redis-driver";

/** 旧名字。测试里的假 Redis 还按这两个名字 implements */
export type InjectedRedis = RedisClient;
export type InjectedPipeline = RedisPipeline;

/** 只给测试：清掉注入、停用窗，并把镜像内存副本就地归零（不能换 Map，闭包还指着旧 cell）。 */
export function resetRedisForTests(): void {
  resetRedisDriverForTests();
  const cells = (
    globalThis as typeof globalThis & {
      __lyjwMirrors?: Map<string, { memory: unknown; persisted: boolean }>;
    }
  ).__lyjwMirrors;
  if (!cells) return;
  for (const cell of cells.values()) {
    cell.memory = null;
    cell.persisted = false;
  }
}

/**
 * 一份「Redis 为主、进程内存为辅」的单键状态。
 *
 * 内存副本只是替补，不是第二份真相。四种情况：
 *
 * 1. Redis 不可达 —— 只能信内存副本。
 * 2. Redis 答了值 —— Redis 赢，刷新内存副本。唯一的例外是上次写没落进去
 *    （`persisted` 为假）且内存那份更新：Redis 停用窗里 set 会静默失败，等它
 *    恢复时里面还是故障前的旧值，无条件优先会把页面钉在旧状态上。
 * 3. Redis 答「没有」且我们写进去过 —— 是真被删了，内存跟着清。
 * 4. Redis 答「没有」且我们没写进去过 —— 写从来没成功，内存是唯一真相，留着。
 *
 * 已知缺陷（沿用旧行为，没修）：删除动作若落在 Redis 停用窗里，等恢复后旧值
 * 会从 Redis 复活。要根治得写墓碑，为这个场景不值当。
 */
export function mirrorKey<T>(
  parts: string[],
  /** 取「这份有多新」。用来在 Redis 写失败过时，挡住旧值把内存里的新值盖回去 */
  stampOf: (value: T) => number,
  { ttlMs }: { ttlMs?: number } = {},
) {
  const k = key(...parts);
  /**
   * 内存副本挂 globalThis，不用模块作用域的变量。
   *
   * Next 的 dev server 里每个路由各有一份模块实例：写进 ingest 那份的内存，
   * status 那份看不见。于是 Redis 一断，读的一侧发现自己手上什么都没有，
   * 就把状态当成空的 —— 实测就是这样，停掉 Redis 后前台应用直接归零，而
   * 规则 1 本该让它继续供数。
   *
   * 这个坑代码库里早有先例：telemetryState 和 reporterLiveness 都是为此挂的
   * globalThis，只是新写的镜像没跟上。
   */
  const cells = ((globalThis as typeof globalThis & {
    __lyjwMirrors?: Map<string, { memory: unknown; persisted: boolean }>;
  }).__lyjwMirrors ??= new Map());
  let cell = cells.get(k);
  if (!cell) {
    cell = { memory: null, persisted: false };
    cells.set(k, cell);
  }
  const state = cell as { memory: T | null; persisted: boolean };

  return {
    async put(value: T): Promise<void> {
      state.memory = value;
      state.persisted = await tellRedis((redis) =>
        ttlMs ? redis.set(k, JSON.stringify(value), "PX", ttlMs) : redis.set(k, JSON.stringify(value)),
      );
    },

    async drop(): Promise<void> {
      state.memory = null;
      state.persisted = await tellRedis((redis) => redis.del(k));
    },

    async get(): Promise<T | null> {
      const answered = await askRedis((redis) => redis.get(k));
      if (!answered.reachable) return state.memory;

      if (answered.value) {
        let stored: T;
        try {
          stored = JSON.parse(answered.value) as T;
        } catch {
          // 脏数据按「答不上来」算，不按「没有」—— 否则会连累好好的内存副本
          return state.memory;
        }
        if (!state.persisted && state.memory && stampOf(state.memory) > stampOf(stored)) {
          return state.memory;
        }
        state.memory = stored;
        state.persisted = true;
        return stored;
      }

      if (state.persisted) {
        state.memory = null;
        return null;
      }
      return state.memory;
    },

    /** Redis 此刻答不答得上话。用来把「里面没有」和「问不到」在报错里分开 */
    async reachable(): Promise<boolean> {
      return (await askRedis(async () => true)).reachable;
    },
  };
}

function overlayHashBlob<T extends object>(
  hash: Record<string, string>,
  blob: string | null,
): T | null {
  let base: Record<string, unknown> | null = null;
  if (blob) {
    try {
      const parsed: unknown = JSON.parse(blob);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      }
    } catch {
      if (Object.keys(hash).length === 0) throw new Error("dirty blob");
    }
  }

  const fields = Object.keys(hash);
  if (fields.length === 0) return (base as T | null) ?? null;

  const next: Record<string, unknown> = { ...(base ?? {}) };
  for (const field of fields) {
    next[field] = JSON.parse(hash[field]!);
  }
  return next as T;
}

function patchHash<T extends object>(base: T | null, incoming: T, fields: readonly (keyof T & string)[]): T {
  const next = { ...(base ?? incoming) } as T;
  for (const field of fields) next[field] = incoming[field];
  return next;
}

function hashFieldValues<T extends object>(
  incoming: T,
  fields: readonly (keyof T & string)[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) {
    out[field] = JSON.stringify(incoming[field] ?? null);
  }
  return out;
}

/**
 * 字段级镜像。每个字段一份 JSON，HSET 只动列出的那些键。
 *
 * 遥测信封按模块到：换歌只带 appleMusic，心跳只带存活。从前整包 SET，后到的
 * 心跳会把 Redis 里刚写进去的正在播盖回上一首 —— 推送用的是内存，刷新 /now
 * 读的是 Redis，于是页面先翻到新歌、一刷新又回去。
 *
 * 整包 JSON（`blobParts`）在每次字段写入后按合并结果再 SET 一份：同一份部署有
 * 好几个函数实例，还在 GET 旧钥匙的那些、以及 hash 里还没出现过的模块，都靠这份
 * 补齐。并发安全仍在 hash 上。
 *
 * 读不用 MULTI：读的实例多半不是刚写过的那个；部分 Redis 代理对事务不友好，
 * 整段失败会退回空的进程内存，看起来像「读到上一首」。
 */
export function overlayHashKey<T extends object>(
  hashParts: string[],
  blobParts: string[],
  stampOf: (value: T) => number,
) {
  const hashK = key(...hashParts);
  const blobK = key(...blobParts);
  const cells = ((globalThis as typeof globalThis & {
    __lyjwMirrors?: Map<string, { memory: unknown; persisted: boolean }>;
  }).__lyjwMirrors ??= new Map());
  let cell = cells.get(hashK);
  if (!cell) {
    cell = { memory: null, persisted: false };
    cells.set(hashK, cell);
  }
  const state = cell as { memory: T | null; persisted: boolean };

  return {
    async merge(incoming: T, fields: readonly (keyof T & string)[]): Promise<void> {
      state.persisted = await tellRedis(async (redis) => {
        const rows = await redis
          .pipeline()
          .hset(hashK, hashFieldValues(incoming, fields))
          .hgetall(hashK)
          .get(blobK)
          .exec();
        if (!rows) throw new Error("telemetry hash merge discarded");
        const hashRow = rows[1];
        const blobRow = rows[2];
        if (!hashRow || !blobRow) throw new Error("telemetry hash merge incomplete");
        if (hashRow[0]) throw hashRow[0];
        if (blobRow[0]) throw blobRow[0];
        const merged = overlayHashBlob<T>(
          hashRow[1] as Record<string, string>,
          blobRow[1] as string | null,
        );
        state.memory = merged;
        if (merged) await redis.set(blobK, JSON.stringify(merged));
      });
      if (!state.persisted) state.memory = patchHash(state.memory, incoming, fields);
    },

    async get(): Promise<T | null> {
      const answered = await askRedis(async (redis) => {
        const rows = await redis.pipeline().hgetall(hashK).get(blobK).exec();
        if (!rows) return { hash: {} as Record<string, string>, blob: null as string | null };
        const hashRow = rows[0];
        const blobRow = rows[1];
        if (!hashRow || !blobRow) return { hash: {} as Record<string, string>, blob: null as string | null };
        if (hashRow[0]) throw hashRow[0];
        if (blobRow[0]) throw blobRow[0];
        return {
          hash: hashRow[1] as Record<string, string>,
          blob: blobRow[1] as string | null,
        };
      });
      if (!answered.reachable) return state.memory;

      let stored: T | null;
      try {
        stored = overlayHashBlob<T>(answered.value.hash, answered.value.blob);
      } catch {
        return state.memory;
      }

      if (stored) {
        if (!state.persisted && state.memory && stampOf(state.memory) > stampOf(stored)) {
          return state.memory;
        }
        state.memory = stored;
        state.persisted = true;
        return stored;
      }

      if (state.persisted) {
        state.memory = null;
        return null;
      }
      return state.memory;
    },
  };
}
