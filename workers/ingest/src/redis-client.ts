import { connect } from "cloudflare:sockets";

import type { RedisClient, RedisPipeline } from "../../../src/lib/redis-driver";

import {
  encodeCommands,
  pairsToRecord,
  parseRedisUrl,
  RespError,
  RespParser,
  type RespReply,
} from "./resp";

/**
 * Workers 上的 Redis 客户端：cloudflare:sockets 上一条 TCP，RESP2，够 lib/redis-driver
 * 那个 `RedisClient` 子集用。
 *
 * 不上 ioredis：它在 nodejs_compat 下能不能跑要赌 `net` 的兼容层，而各 store 实际用到
 * 的命令只有十来个，自己写一遍两百行、每一行都看得见。
 *
 * 一条连接上的命令**串行**：先写后读、按序对应。并发的 exchange 排成一条链，各自
 * 拿到自己那几条回复。租约（lib/connection-leases）在最后一个请求结束时 disconnect。
 */

type Command = readonly (string | number)[];

const CONNECT_TIMEOUT_MS = 2_000;
const COMMAND_TIMEOUT_MS = 2_000;

export class WorkerRedis implements RedisClient {
  private readonly ready: Promise<void>;
  private socket: Socket | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private readonly parser = new RespParser();
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(url: string) {
    this.ready = this.open(url);
    // 打不开时这里只是标记；真正的错误在第一次命令里抛给调用方
    this.ready.catch(() => {
      this.disconnect();
    });
  }

  private async open(url: string): Promise<void> {
    const address = parseRedisUrl(url);
    const socket = connect(
      { hostname: address.hostname, port: address.port },
      { secureTransport: address.tls ? "on" : "off", allowHalfOpen: false },
    );
    this.socket = socket;
    this.writer = socket.writable.getWriter();
    this.reader = socket.readable.getReader();
    await withTimeout(socket.opened, CONNECT_TIMEOUT_MS, "连接 Redis 超时");

    const handshake: Command[] = [];
    if (address.password) {
      handshake.push(
        address.username ? ["AUTH", address.username, address.password] : ["AUTH", address.password],
      );
    }
    if (address.db) handshake.push(["SELECT", address.db]);
    if (handshake.length) {
      const replies = await this.exchangeNow(handshake);
      for (const reply of replies) if (reply instanceof RespError) throw reply;
    }
  }

  /** 排队一组命令，按序拿回同样多条回复 */
  private exchange(commands: Command[]): Promise<RespReply[]> {
    const run = async () => {
      await this.ready;
      return this.exchangeNow(commands);
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async exchangeNow(commands: Command[]): Promise<RespReply[]> {
    if (this.closed || !this.writer || !this.reader) throw new Error("Redis 连接已关闭");
    const work = (async () => {
      await this.writer!.write(encodeCommands(commands));
      const replies: RespReply[] = [];
      while (replies.length < commands.length) {
        const reply = this.parser.next();
        if (reply !== undefined) {
          replies.push(reply);
          continue;
        }
        const { value, done } = await this.reader!.read();
        if (done) throw new Error("Redis 关闭了连接");
        this.parser.push(value);
      }
      return replies;
    })();
    try {
      return await withTimeout(work, COMMAND_TIMEOUT_MS, "Redis 命令超时");
    } catch (error) {
      // 超时或半截回复之后这条连接的读写位置已经对不上，只能整条作废
      this.disconnect();
      throw error;
    }
  }

  private async single(command: Command): Promise<RespReply> {
    const [reply] = await this.exchange([command]);
    if (reply instanceof RespError) throw reply;
    return reply ?? null;
  }

  async get(key: string): Promise<string | null> {
    const reply = await this.single(["GET", key]);
    return typeof reply === "string" ? reply : null;
  }

  async set(key: string, value: string, ...args: (string | number)[]): Promise<unknown> {
    return this.single(["SET", key, value, ...args]);
  }

  async del(key: string): Promise<number> {
    const reply = await this.single(["DEL", key]);
    return typeof reply === "number" ? reply : 0;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const reply = await this.single(["LRANGE", key, start, stop]);
    return Array.isArray(reply) ? reply.filter((item): item is string => typeof item === "string") : [];
  }

  pipeline(): RedisPipeline {
    const commands: Command[] = [];
    const queue = (command: Command) => {
      commands.push(command);
      return pipe;
    };
    const pipe: RedisPipeline = {
      set: (key, value, ...args) => queue(["SET", key, value, ...args]),
      del: (key) => queue(["DEL", key]),
      rpush: (key, ...values) => queue(["RPUSH", key, ...values]),
      ltrim: (key, start, stop) => queue(["LTRIM", key, start, stop]),
      pexpire: (key, ms) => queue(["PEXPIRE", key, ms]),
      hset: (key, object) => queue(["HSET", key, ...Object.entries(object).flat()]),
      hgetall: (key) => queue(["HGETALL", key]),
      get: (key) => queue(["GET", key]),
      exec: async () => {
        if (!commands.length) return [];
        const replies = await this.exchange(commands);
        return replies.map((reply, index): [Error | null, unknown] => {
          if (reply instanceof RespError) return [reply, null];
          if (commands[index]?.[0] === "HGETALL") return [null, pairsToRecord(reply)];
          return [null, reply];
        });
      },
    };
    return pipe;
  }

  disconnect(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.writer?.releaseLock();
      this.reader?.releaseLock();
    } catch {}
    this.socket?.close().catch(() => undefined);
    this.socket = null;
    this.writer = null;
    this.reader = null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
