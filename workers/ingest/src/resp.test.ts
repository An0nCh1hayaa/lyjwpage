import assert from "node:assert/strict";
import test from "node:test";

import { encodeCommand, pairsToRecord, parseRedisUrl, RespError, RespParser } from "./resp.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

test("命令编成 RESP 数组，参数按字节长度计", () => {
  const encoded = new TextDecoder().decode(encodeCommand(["SET", "k", "值", 5]));
  assert.equal(encoded, "*4\r\n$3\r\nSET\r\n$1\r\nk\r\n$3\r\n值\r\n$1\r\n5\r\n");
});

test("五种回复各解各的", () => {
  const parser = new RespParser();
  parser.push(bytes("+OK\r\n-ERR bad\r\n:42\r\n$5\r\nhello\r\n$-1\r\n*2\r\n$1\r\na\r\n:1\r\n*-1\r\n"));
  assert.equal(parser.next(), "OK");
  const error = parser.next();
  assert.ok(error instanceof RespError);
  assert.equal(error.message, "ERR bad");
  assert.equal(parser.next(), 42);
  assert.equal(parser.next(), "hello");
  assert.equal(parser.next(), null);
  assert.deepEqual(parser.next(), ["a", 1]);
  assert.equal(parser.next(), null);
  assert.equal(parser.next(), undefined);
});

test("半截回复不吐，补齐字节后接着解", () => {
  const parser = new RespParser();
  parser.push(bytes("$11\r\nhello"));
  assert.equal(parser.next(), undefined);
  parser.push(bytes(" wor"));
  assert.equal(parser.next(), undefined);
  parser.push(bytes("ld\r\n:7\r"));
  assert.equal(parser.next(), "hello world");
  assert.equal(parser.next(), undefined);
  parser.push(bytes("\n"));
  assert.equal(parser.next(), 7);
});

test("数组里嵌半截也整条等", () => {
  const parser = new RespParser();
  parser.push(bytes("*2\r\n$1\r\nx\r\n"));
  assert.equal(parser.next(), undefined);
  parser.push(bytes("$1\r\ny\r\n+next\r\n"));
  assert.deepEqual(parser.next(), ["x", "y"]);
  assert.equal(parser.next(), "next");
});

test("HGETALL 的扁平数组折成对象", () => {
  assert.deepEqual(pairsToRecord(["a", "1", "b", "2"]), { a: "1", b: "2" });
  assert.deepEqual(pairsToRecord([]), {});
  assert.deepEqual(pairsToRecord(null), {});
});

test("REDIS_URL 解析出账号、库号和 TLS", () => {
  assert.deepEqual(parseRedisUrl("redis://default:p%40ss@host.example:10060"), {
    hostname: "host.example",
    port: 10060,
    username: "default",
    password: "p@ss",
    db: 0,
    tls: false,
  });
  assert.deepEqual(parseRedisUrl("rediss://:secret@host.example/3"), {
    hostname: "host.example",
    port: 6379,
    username: null,
    password: "secret",
    db: 3,
    tls: true,
  });
  assert.throws(() => parseRedisUrl("http://host"), /redis:\/\//);
});
