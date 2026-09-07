import { withRequestState } from "@shared/request-state";
import { publicResponse } from "./public-api";
import { DurableObject } from "cloudflare:workers";
import { StorageClient } from "@shared/storage-client";
import { SqliteStore, type StoredEntry } from "@shared/sqlite-store";
import type { StorageCommand } from "@shared/storage-contract";
import { HANDLERS } from "./ingest-handlers";
import { requestStore, type Env } from "./runtime";

/** 单个站点一个对象。所有上报的读、合并、写按顺序完成，避免不同信封互相覆盖。 */
export class StateHub extends DurableObject<Env> {
  private database: SqliteStore;
  private alarmScheduled = false;
  private ingestTail: Promise<unknown> = Promise.resolve();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.database = new SqliteStore(ctx.storage.sql, (work) => ctx.storage.transactionSync(work));
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }

  ready(): boolean {
    return this.ctx.storage.sql.exec("SELECT value FROM metadata WHERE key = 'initialized'").toArray()[0]?.value === "1";
  }
  finishImport(): void {
    this.ctx.storage.sql.exec("INSERT INTO metadata(key, value) VALUES ('initialized', '1') ON CONFLICT(key) DO UPDATE SET value = '1'");
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.ready()) return Response.json({ ok: false, error: "状态存储初始化中" }, { status: 503 });
    // 等已接受的写入完成，读取使用自己的工作副本；不与其他请求共享 Promise 或状态对象。
    await this.ingestTail;
    return withRequestState(() => requestStore.run({ env: this.env, ctx: this.ctx,
      storage: new StorageClient(async (commands) => this.database.execute(commands)),
    }, () => publicResponse(request)));
  }

  async execute(commands: StorageCommand[]): Promise<unknown[]> {
    const result = this.database.execute(commands);
    await this.ensureAlarm();
    return result;
  }

  ingest(source: string, body: unknown): Promise<{ ready: boolean; json: string }> {
    if (!this.ready()) return Promise.resolve({ ready: false, json: "null" });
    const handler = Object.hasOwn(HANDLERS, source) ? HANDLERS[source] : undefined;
    if (!handler) throw new Error("Unknown ingest source");
    const result = this.ingestTail.then(() => withRequestState(() => requestStore.run({
      env: this.env,
      ctx: this.ctx,
      storage: new StorageClient(async (commands) => this.database.execute(commands)),
    }, async () => {
      const data = await handler(body);
      await this.ensureAlarm();
      return { ready: true, json: JSON.stringify(data) };
    })));
    this.ingestTail = result.catch(() => {});
    return result;
  }

  async importMissing(entries: StoredEntry[]): Promise<number> {
    const count = this.database.importMissing(entries);
    await this.ensureAlarm();
    return count;
  }
  private async ensureAlarm(): Promise<void> {
    if (this.alarmScheduled) return;
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 60 * 60_000);
    this.alarmScheduled = true;
  }
  async alarm(): Promise<void> {
    const removed = this.database.purgeExpired();
    await this.ctx.storage.setAlarm(Date.now() + (removed === 1000 ? 1000 : 60 * 60_000));
  }
}
