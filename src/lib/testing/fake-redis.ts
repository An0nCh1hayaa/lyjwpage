import type { InjectedPipeline, InjectedRedis } from "@/lib/redis";

type StringRecord = { value: string; expiresAt?: number };

/**
 * 内存 Redis。只覆盖 lib/redis-driver 的 `RedisClient` 子集 —— 各 store 实际会调到的
 * 那几个方法。`setUnreachable()` 让命令抛错，用来测 UNREACHABLE 回退。
 */
export class FakeRedis implements InjectedRedis {
  private unreachable = false;
  private strings = new Map<string, StringRecord>();
  private hashes = new Map<string, Map<string, string>>();
  private lists = new Map<string, string[]>();

  setUnreachable(value = true): void {
    this.unreachable = value;
  }

  disconnect(): void {
    // 租约每次 operation 结束都会 disconnect。数据必须留着，好被 getRedis 再次 use。
  }

  async get(key: string): Promise<string | null> {
    this.failIfUnreachable();
    this.purgeExpired(key);
    return this.strings.get(key)?.value ?? null;
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<"OK"> {
    this.failIfUnreachable();
    const record: StringRecord = { value: String(value) };
    if (args[0] === "PX") {
      const ms = Number(args[1]);
      if (Number.isFinite(ms)) record.expiresAt = Date.now() + ms;
    }
    this.strings.set(key, record);
    this.hashes.delete(key);
    this.lists.delete(key);
    return "OK";
  }

  async del(key: string): Promise<number> {
    this.failIfUnreachable();
    const had = this.strings.delete(key) || this.hashes.delete(key) || this.lists.delete(key);
    return had ? 1 : 0;
  }

  async hset(key: string, object: object): Promise<number> {
    this.failIfUnreachable();
    let hash = this.hashes.get(key);
    if (!hash) {
      hash = new Map();
      this.hashes.set(key, hash);
    }
    this.strings.delete(key);
    let added = 0;
    for (const [field, fieldValue] of Object.entries(object)) {
      if (!hash.has(field)) added += 1;
      hash.set(field, String(fieldValue));
    }
    return added;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    this.failIfUnreachable();
    const hash = this.hashes.get(key);
    if (!hash) return {};
    return Object.fromEntries(hash);
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    this.failIfUnreachable();
    const list = this.lists.get(key) ?? [];
    list.push(...values);
    this.lists.set(key, list);
    return list.length;
  }

  async ltrim(key: string, start: number, stop: number): Promise<"OK"> {
    this.failIfUnreachable();
    const list = this.lists.get(key);
    if (list) this.lists.set(key, list.slice(...range(list.length, start, stop)));
    return "OK";
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    this.failIfUnreachable();
    const list = this.lists.get(key) ?? [];
    return list.slice(...range(list.length, start, stop));
  }

  async pexpire(): Promise<number> {
    this.failIfUnreachable();
    // 列表的 TTL 在测试里不推进，只认写没写
    return 1;
  }

  pipeline(): InjectedPipeline {
    const commands: Array<() => Promise<unknown>> = [];
    const queue = (command: () => Promise<unknown>) => {
      commands.push(command);
      return pipe;
    };
    const pipe: InjectedPipeline = {
      set: (key, value, ...args) => queue(() => this.set(key, value, ...args)),
      del: (key) => queue(() => this.del(key)),
      rpush: (key, ...values) => queue(() => this.rpush(key, ...values)),
      ltrim: (key, start, stop) => queue(() => this.ltrim(key, start, stop)),
      pexpire: () => queue(() => this.pexpire()),
      hset: (key, object) => queue(() => this.hset(key, object)),
      hgetall: (key) => queue(() => this.hgetall(key)),
      get: (key) => queue(() => this.get(key)),
      exec: async () => {
        this.failIfUnreachable();
        const rows: [Error | null, unknown][] = [];
        for (const command of commands) {
          try {
            rows.push([null, await command()]);
          } catch (error) {
            rows.push([error instanceof Error ? error : new Error(String(error)), null]);
          }
        }
        return rows;
      },
    };
    return pipe;
  }

  private failIfUnreachable(): void {
    if (this.unreachable) throw new Error("fake redis unreachable");
  }

  private purgeExpired(key: string): void {
    const record = this.strings.get(key);
    if (record?.expiresAt != null && record.expiresAt <= Date.now()) {
      this.strings.delete(key);
    }
  }
}

/** Redis 的闭区间 + 负下标，换成 slice 的 [start, end) */
function range(length: number, start: number, stop: number): [number, number] {
  const from = start < 0 ? Math.max(length + start, 0) : start;
  const to = stop < 0 ? length + stop : Math.min(stop, length - 1);
  return [from, to + 1];
}
