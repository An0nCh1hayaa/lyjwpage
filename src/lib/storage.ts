import { requestState } from "@shared/request-state";
import { askStorage, key, resetStorageDriverForTests, tellStorage } from "@/lib/storage-driver";
export { askStorage, getStorage, installStorageForTests, key, tellStorage, withStorage, withStorageScope, type StorageAnswer, type StorageClient, type StorageBatch } from "@/lib/storage-driver";

type Cell<T> = { memory: T | null; persisted: boolean };
const cells = () => requestState("storage-mirrors", () => new Map<string, Cell<unknown>>());
function cell<T>(k: string): Cell<T> {
  if (!cells().has(k)) cells().set(k, { memory: null, persisted: false });
  return cells().get(k) as Cell<T>;
}

export function resetStorageForTests(): void {
  resetStorageDriverForTests();
  for (const value of cells().values()) { value.memory = null; value.persisted = false; }
}

/** Vercel 故障时可用已有内存副本；Worker 驱动严格抛错，不接受只写到内存的上报。 */
function remember<T>(state: Cell<T>, stored: T | null, stampOf: (value: T) => number): T | null {
  if (stored !== null) {
    if (!state.persisted && state.memory && stampOf(state.memory) > stampOf(stored)) return state.memory;
    state.memory = stored;
    state.persisted = true;
    return stored;
  }
  if (state.persisted) state.memory = null;
  return state.memory;
}

export function mirrorKey<T>(parts: string[], stampOf: (value: T) => number, { ttlMs }: { ttlMs?: number } = {}) {
  const k = key(...parts);
  const state = () => cell<T>(k);
  return {
    async put(value: T): Promise<void> {
      const persisted = await tellStorage((storage) => storage.set(k, JSON.stringify(value), ttlMs ? { ttlMs } : undefined));
      state().memory = value;
      state().persisted = persisted;
    },
    async drop(): Promise<void> {
      const persisted = await tellStorage((storage) => storage.remove(k));
      state().memory = null;
      state().persisted = persisted;
    },
    async get(): Promise<T | null> {
      const answered = await askStorage((storage) => storage.get(k));
      if (!answered.reachable) return state().memory;
      try { return remember(state(), answered.value === null ? null : JSON.parse(answered.value) as T, stampOf); }
      catch { return state().memory; }
    },
    async reachable(): Promise<boolean> { return (await askStorage((storage) => storage.get(k))).reachable; },
  };
}

/** 每个模块一个字段；只合并此次上报的字段，不再维护一份重复的整包快照。 */
export function fieldMirror<T extends object>(parts: string[], stampOf: (value: T) => number) {
  const k = key(...parts);
  const state = () => cell<T>(k);
  function decode(fields: Record<string, string>): T | null {
    if (!Object.keys(fields).length) return null;
    return Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, JSON.parse(value)])) as T;
  }
  return {
    async merge(incoming: T, fields: readonly (keyof T & string)[]): Promise<void> {
      const values = Object.fromEntries(fields.map((field) => [field, JSON.stringify(incoming[field] ?? null)]));
      let merged: T | null = null;
      const persisted = await tellStorage(async (storage) => {
        const result = await storage.batch().patch(k, values).fields(k).execute();
        merged = decode(result[1] as Record<string, string>);
      });
      state().persisted = persisted;
      state().memory = persisted ? merged : { ...(state().memory ?? incoming), ...Object.fromEntries(fields.map((field) => [field, incoming[field]])) } as T;
    },
    async get(): Promise<T | null> {
      const answer = await askStorage(async (storage) => (await storage.batch().fields(k).execute())[0] as Record<string, string>);
      if (!answer.reachable) return state().memory;
      try { return remember(state(), decode(answer.value), stampOf); }
      catch { return state().memory; }
    },
  };
}
