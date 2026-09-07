import type { StorageCommand, WriteOptions } from "@shared/storage-contract";

export type StorageExecutor = (commands: StorageCommand[]) => Promise<unknown[]>;

/** 一批命令在一个 SQLite 事务内完成；任何一条失败时整批回滚。 */
export class StorageBatch {
  private commands: StorageCommand[] = [];
  private run: StorageExecutor;
  constructor(run: StorageExecutor) { this.run = run; }
  private queue(command: StorageCommand): this { this.commands.push(command); return this; }
  set(key: string, value: string, options?: WriteOptions): this { return this.queue({ op: "set", key, value, options }); }
  remove(key: string): this { return this.queue({ op: "remove", key }); }
  get(key: string): this { return this.queue({ op: "get", key }); }
  fields(key: string): this { return this.queue({ op: "fields", key }); }
  patch(key: string, fields: Record<string, string>): this { return this.queue({ op: "patch", key, fields }); }
  append(key: string, ...values: string[]): this { return this.queue({ op: "append", key, values }); }
  trim(key: string, start: number, stop: number): this { return this.queue({ op: "trim", key, start, stop }); }
  expire(key: string, ttlMs: number): this { return this.queue({ op: "expire", key, ttlMs }); }
  execute(): Promise<unknown[]> { return this.commands.length ? this.run(this.commands) : Promise.resolve([]); }
}

export class StorageClient {
  private run: StorageExecutor;
  constructor(run: StorageExecutor) { this.run = run; }
  async get(key: string): Promise<string | null> { return (await this.run([{ op: "get", key }]))[0] as string | null; }
  async set(key: string, value: string, options?: WriteOptions): Promise<boolean> { return (await this.run([{ op: "set", key, value, options }]))[0] as boolean; }
  async remove(key: string): Promise<number> { return (await this.run([{ op: "remove", key }]))[0] as number; }
  async listRange(key: string, start: number, stop: number): Promise<string[]> { return (await this.run([{ op: "listRange", key, start, stop }]))[0] as string[]; }
  batch(): StorageBatch { return new StorageBatch(this.run); }
}
