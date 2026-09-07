import { parseCommands, type StorageCommand } from "@shared/storage-contract";

type SqlValue = string | number | null | ArrayBuffer;
type Row = Record<string, SqlValue>;
export interface SqlDatabase {
  exec(query: string, ...bindings: SqlValue[]): { toArray(): Row[]; rowsWritten: number };
}
export type StoredEntry = { key: string; kind: "string" | "hash" | "list"; value: string | Record<string, string> | string[]; expiresAt: number | null };

/** SQL 引擎不依赖 Worker，生产使用 DO SQLite，行为测试使用真实 Node SQLite。 */
export class SqliteStore {
  private sql: SqlDatabase;
  private transaction: <T>(work: () => T) => T;
  private now: () => number;
  constructor(sql: SqlDatabase, transaction: <T>(work: () => T) => T, now: () => number = Date.now) {
    this.sql = sql; this.transaction = transaction; this.now = now;
    sql.exec(`CREATE TABLE IF NOT EXISTS entries (
      key TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('string','hash','list')),
      value TEXT, expires_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS entries_expiry ON entries(expires_at) WHERE expires_at IS NOT NULL;
    CREATE TABLE IF NOT EXISTS fields (key TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(key, field));
    CREATE TABLE IF NOT EXISTS samples (key TEXT NOT NULL, seq INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(key, seq));`);
  }

  execute(commands: StorageCommand[]): unknown[] {
    parseCommands(commands);
    return this.transaction(() => commands.map((command) => this.command(command)));
  }

  private entry(key: string): Row | undefined {
    const row = this.sql.exec("SELECT kind, value, expires_at FROM entries WHERE key = ?", key).toArray()[0];
    if (row && row.expires_at !== null && Number(row.expires_at) <= this.now()) { this.remove(key); return undefined; }
    return row;
  }
  private requireKind(key: string, kind: string): Row | undefined {
    const row = this.entry(key);
    if (row && row.kind !== kind) throw new Error("Storage type mismatch");
    return row;
  }
  private remove(key: string): number {
    this.sql.exec("DELETE FROM fields WHERE key = ?", key);
    this.sql.exec("DELETE FROM samples WHERE key = ?", key);
    return this.sql.exec("DELETE FROM entries WHERE key = ?", key).rowsWritten;
  }
  private count(key: string): number { return Number(this.sql.exec("SELECT COUNT(*) AS n FROM samples WHERE key = ?", key).toArray()[0]?.n ?? 0); }
  private range(length: number, start: number, stop: number): [number, number] {
    const from = start < 0 ? Math.max(length + start, 0) : start;
    const to = stop < 0 ? length + stop : Math.min(stop, length - 1);
    return [from, Math.max(0, to - from + 1)];
  }

  private command(command: StorageCommand): unknown {
    const { key } = command;
    switch (command.op) {
      case "get": return this.requireKind(key, "string")?.value ?? null;
      case "set": {
        const previous = this.entry(key);
        if (previous && command.options?.ifAbsent) return false;
        if (previous && previous.kind !== "string") this.remove(key);
        this.sql.exec("INSERT INTO entries(key, kind, value, expires_at) VALUES (?, 'string', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at", key, command.value, command.options?.ttlMs ? this.now() + command.options.ttlMs : null);
        return true;
      }
      case "remove": this.entry(key); return this.remove(key);
      case "expire": {
        if (!this.entry(key)) return 0;
        this.sql.exec("UPDATE entries SET expires_at = ? WHERE key = ?", this.now() + command.ttlMs, key);
        return 1;
      }
      case "patch": {
        this.requireKind(key, "hash");
        this.sql.exec("INSERT OR IGNORE INTO entries(key, kind) VALUES (?, 'hash')", key);
        for (const [field, value] of Object.entries(command.fields)) {
          this.sql.exec("INSERT INTO fields(key, field, value) VALUES (?, ?, ?) ON CONFLICT(key, field) DO UPDATE SET value = excluded.value", key, field, value);
        }
        return Object.keys(command.fields).length;
      }
      case "fields": {
        if (!this.requireKind(key, "hash")) return {};
        return Object.fromEntries(this.sql.exec("SELECT field, value FROM fields WHERE key = ?", key).toArray().map((row) => [String(row.field), String(row.value)]));
      }
      case "append": {
        this.requireKind(key, "list");
        if (!command.values.length) return this.count(key);
        this.sql.exec("INSERT OR IGNORE INTO entries(key, kind) VALUES (?, 'list')", key);
        let seq = Number(this.sql.exec("SELECT COALESCE(MAX(seq), 0) AS n FROM samples WHERE key = ?", key).toArray()[0]?.n ?? 0);
        for (const value of command.values) this.sql.exec("INSERT INTO samples(key, seq, value) VALUES (?, ?, ?)", key, ++seq, value);
        return this.count(key);
      }
      case "listRange": {
        if (!this.requireKind(key, "list")) return [];
        const [offset, limit] = this.range(this.count(key), command.start, command.stop);
        return this.sql.exec("SELECT value FROM samples WHERE key = ? ORDER BY seq LIMIT ? OFFSET ?", key, limit, offset).toArray().map((row) => String(row.value));
      }
      case "trim": {
        if (!this.requireKind(key, "list")) return true;
        const [offset, limit] = this.range(this.count(key), command.start, command.stop);
        if (!limit) { this.remove(key); return true; }
        this.sql.exec("DELETE FROM samples WHERE key = ? AND seq NOT IN (SELECT seq FROM samples WHERE key = ? ORDER BY seq LIMIT ? OFFSET ?)", key, key, limit, offset);
        return true;
      }
    }
  }

  purgeExpired(): number {
    return this.transaction(() => {
      const rows = this.sql.exec("SELECT key FROM entries WHERE expires_at <= ? LIMIT 1000", this.now()).toArray();
      for (const row of rows) this.remove(String(row.key));
      return rows.length;
    });
  }

  /** 迁移只写空键，绝不覆盖已经收到的新上报；过期时间沿用来源的绝对时间。 */
  importMissing(entries: StoredEntry[]): number {
    return this.transaction(() => {
      let imported = 0;
      for (const entry of entries) {
        if (this.entry(entry.key) || (entry.expiresAt !== null && entry.expiresAt <= this.now())) continue;
        if (entry.kind === "string" && typeof entry.value === "string") this.command({ op: "set", key: entry.key, value: entry.value });
        else if (entry.kind === "hash" && entry.value && typeof entry.value === "object" && !Array.isArray(entry.value)) this.command({ op: "patch", key: entry.key, fields: entry.value });
        else if (entry.kind === "list" && Array.isArray(entry.value)) this.command({ op: "append", key: entry.key, values: entry.value });
        else throw new Error("Invalid imported entry");
        if (entry.expiresAt !== null) this.sql.exec("UPDATE entries SET expires_at = ? WHERE key = ?", entry.expiresAt, entry.key);
        imported++;
      }
      return imported;
    });
  }
}
