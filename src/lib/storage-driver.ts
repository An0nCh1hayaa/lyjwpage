import { StorageClient } from "@shared/storage-client";

export { StorageClient };
export type { StorageBatch } from "@shared/storage-client";
export type StorageAnswer<T> = { reachable: true; value: T } | { reachable: false };

let injected: StorageClient | null | undefined;

/** 持久层只由 Worker 的 alias 驱动提供；Node 驱动仅用于单元测试。 */
export function getStorage(): StorageClient | null { return injected ?? null; }

export function withStorageScope<T>(run: () => Promise<T>): Promise<T> { return run(); }
export function installStorageForTests(client: StorageClient | null): void { injected = client; }
export function resetStorageDriverForTests(): void { injected = undefined; }
export function key(...parts: string[]): string { return [process.env.STORAGE_PREFIX ?? "lyjwpage", ...parts].join(":"); }

export async function withStorage<T>(run: (storage: StorageClient) => Promise<T>, fallback: T): Promise<T> {
  const storage = getStorage();
  if (!storage) return fallback;
  try { return await run(storage); }
  catch (error) { console.error("[storage]", error instanceof Error ? error.message : String(error)); return fallback; }
}
export function askStorage<T>(load: (storage: StorageClient) => Promise<T>): Promise<StorageAnswer<T>> {
  return withStorage<StorageAnswer<T>>(async (storage) => ({ reachable: true, value: await load(storage) }), { reachable: false });
}
export function tellStorage(run: (storage: StorageClient) => Promise<unknown>): Promise<boolean> {
  return withStorage(async (storage) => { await run(storage); return true; }, false);
}
