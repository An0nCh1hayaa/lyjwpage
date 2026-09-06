/**
 * RESP2 的编解码，不含任何 socket。
 *
 * 独立成文件是为了能在 node:test 里直接喂字节验证；连接和超时在 redis-client.ts。
 * 只实现 Redis 会回给我们的五种类型：简单字符串、错误、整数、批量字符串、数组。
 * 错误回复解析成 `RespError` 实例返回而不是抛出 —— pipeline 里一条失败不该打断
 * 后面几条的读取，ioredis 也是按 `[error, result]` 逐条给的。
 */

export class RespError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RespError";
  }
}

export type RespReply = string | number | null | RespError | RespReply[];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 一条命令编成 RESP 数组：每个参数一个批量字符串 */
export function encodeCommand(args: readonly (string | number)[]): Uint8Array {
  const parts: Uint8Array[] = [encoder.encode(`*${args.length}\r\n`)];
  for (const arg of args) {
    const bytes = encoder.encode(String(arg));
    parts.push(encoder.encode(`$${bytes.byteLength}\r\n`), bytes, encoder.encode("\r\n"));
  }
  return concat(parts);
}

export function encodeCommands(commands: readonly (readonly (string | number)[])[]): Uint8Array {
  return concat(commands.map(encodeCommand));
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * 增量解析器：`push` 进字节，`next` 每次吐一条完整回复，不够一条就返回 undefined
 * 并保留已读的部分。回复被完整取走后，缓冲区里已消费的字节才丢掉。
 */
export class RespParser {
  private buffer: Uint8Array = new Uint8Array(0);
  private offset = 0;

  push(chunk: Uint8Array): void {
    if (this.offset > 0) {
      this.buffer = this.buffer.subarray(this.offset);
      this.offset = 0;
    }
    if (this.buffer.byteLength === 0) {
      this.buffer = chunk;
      return;
    }
    this.buffer = concat([this.buffer, chunk]);
  }

  next(): RespReply | undefined {
    const start = this.offset;
    const reply = this.read();
    if (reply === INCOMPLETE) {
      this.offset = start;
      return undefined;
    }
    return reply;
  }

  private read(): RespReply | typeof INCOMPLETE {
    if (this.offset >= this.buffer.byteLength) return INCOMPLETE;
    const type = this.buffer[this.offset]!;
    const line = this.readLine();
    if (line === INCOMPLETE) return INCOMPLETE;

    switch (type) {
      case 0x2b: // +
        return line;
      case 0x2d: // -
        return new RespError(line);
      case 0x3a: // :
        return Number(line);
      case 0x24: {
        // $
        const length = Number(line);
        if (length < 0) return null;
        if (this.offset + length + 2 > this.buffer.byteLength) return INCOMPLETE;
        const bytes = this.buffer.subarray(this.offset, this.offset + length);
        this.offset += length + 2;
        return decoder.decode(bytes);
      }
      case 0x2a: {
        // *
        const count = Number(line);
        if (count < 0) return null;
        const items: RespReply[] = [];
        for (let index = 0; index < count; index += 1) {
          const item = this.read();
          if (item === INCOMPLETE) return INCOMPLETE;
          items.push(item);
        }
        return items;
      }
      default:
        throw new RespError(`不认识的 RESP 类型：${String.fromCharCode(type)}`);
    }
  }

  /** 读到 CRLF 为止的一行（不含类型字节和 CRLF），并把 offset 挪到行后 */
  private readLine(): string | typeof INCOMPLETE {
    for (let index = this.offset + 1; index + 1 < this.buffer.byteLength; index += 1) {
      if (this.buffer[index] === 0x0d && this.buffer[index + 1] === 0x0a) {
        const line = decoder.decode(this.buffer.subarray(this.offset + 1, index));
        this.offset = index + 2;
        return line;
      }
    }
    return INCOMPLETE;
  }
}

const INCOMPLETE = Symbol("incomplete");

/** HGETALL 回的是扁平的 [field, value, field, value, ...]，ioredis 给的是对象 */
export function pairsToRecord(reply: RespReply): Record<string, string> {
  if (!Array.isArray(reply)) return {};
  const out: Record<string, string> = {};
  for (let index = 0; index + 1 < reply.length; index += 2) {
    const field = reply[index];
    const value = reply[index + 1];
    if (typeof field === "string" && typeof value === "string") out[field] = value;
  }
  return out;
}

export type RedisAddress = {
  hostname: string;
  port: number;
  username: string | null;
  password: string | null;
  db: number;
  tls: boolean;
};

/** redis:// 与 rediss://。路径上的 /N 是库号 */
export function parseRedisUrl(raw: string): RedisAddress {
  const url = new URL(raw);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error(`REDIS_URL 要用 redis:// 或 rediss://：${url.protocol}`);
  }
  const db = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0;
  return {
    hostname: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    username: url.username ? decodeURIComponent(url.username) : null,
    password: url.password ? decodeURIComponent(url.password) : null,
    db: Number.isFinite(db) ? db : 0,
    tls: url.protocol === "rediss:",
  };
}
