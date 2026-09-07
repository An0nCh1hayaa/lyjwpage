/** Worker 与 Vercel 共用的存储协议；没有 SQL 或任意远程命令入口。 */
export type WriteOptions = { ttlMs?: number; ifAbsent?: boolean };
export type StorageCommand =
  | { op: "get" | "remove" | "fields"; key: string }
  | { op: "set"; key: string; value: string; options?: WriteOptions }
  | { op: "append"; key: string; values: string[] }
  | { op: "listRange" | "trim"; key: string; start: number; stop: number }
  | { op: "expire"; key: string; ttlMs: number }
  | { op: "patch"; key: string; fields: Record<string, string> };

export const STORAGE_MAX_BYTES = 4 * 1024 * 1024;
export const STORAGE_MAX_COMMANDS = 128;

export function parseCommands(value: unknown): StorageCommand[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > STORAGE_MAX_COMMANDS) {
    throw new Error("Invalid storage batch");
  }
  for (const row of value) {
    if (!row || typeof row !== "object" || typeof row.key !== "string" || !row.key || row.key.length > 1024) {
      throw new Error("Invalid storage key");
    }
    switch (row.op) {
      case "get": case "remove": case "fields": break;
      case "set":
        if (typeof row.value !== "string") throw new Error("Invalid value");
        if (row.options !== undefined) {
          if (!row.options || typeof row.options !== "object" || Array.isArray(row.options)) throw new Error("Invalid options");
          if (row.options.ttlMs !== undefined) validTtl(row.options.ttlMs);
          if (row.options.ifAbsent !== undefined && typeof row.options.ifAbsent !== "boolean") throw new Error("Invalid condition");
        }
        break;
      case "append":
        if (!Array.isArray(row.values) || row.values.length > 10000 || !row.values.every((v: unknown) => typeof v === "string")) throw new Error("Invalid list");
        break;
      case "listRange": case "trim":
        if (!Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.stop)) throw new Error("Invalid range");
        break;
      case "expire": validTtl(row.ttlMs); break;
      case "patch":
        if (!row.fields || typeof row.fields !== "object" || Array.isArray(row.fields) || !Object.values(row.fields).every((v) => typeof v === "string")) throw new Error("Invalid fields");
        break;
      default: throw new Error("Unknown operation");
    }
  }
  return value as StorageCommand[];
}

function validTtl(value: unknown): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid TTL");
}
