/**
 * 服务器上报报文的类型收敛。
 *
 * 这份文件不碰 SQLite：校验是纯函数，测试和入库走同一条。
 */

import { number, object, text } from "./json.ts";
import type { ServerStatus } from "./types.ts";

function requiredText(row: Record<string, unknown>, field: string): string {
  const value = text(row[field]);
  if (!value) throw new Error(`服务器上报的 ${field} 必须是非空字符串`);
  return value;
}

function requiredNumber(row: Record<string, unknown>, field: string): number {
  const value = number(row[field]);
  if (value == null) throw new Error(`服务器上报的 ${field} 必须是数字`);
  if (value < 0) throw new Error(`服务器上报的 ${field} 不能为负`);
  return value;
}

function requiredPositive(row: Record<string, unknown>, field: string): number {
  const value = requiredNumber(row, field);
  if (value === 0) throw new Error(`服务器上报的 ${field} 必须大于 0`);
  return value;
}

/** 0–100。浮点噪声先收成一位小数再夹紧，100.04 那种不该把整封打回去 */
function requiredPercent(row: Record<string, unknown>, field: string): number {
  const value = requiredNumber(row, field);
  return Math.min(100, Math.round(value * 10) / 10);
}

/** 键必须在，值可以是 null。查 IP 失败时上报器仍要交这几个字段 */
function nullableText(row: Record<string, unknown>, field: string): string | null {
  if (!(field in row)) throw new Error(`服务器上报缺少 ${field}`);
  if (row[field] == null) return null;
  return requiredText(row, field);
}

function nullableAsn(row: Record<string, unknown>): number | null {
  if (!("asn" in row)) throw new Error("服务器上报缺少 asn");
  if (row.asn == null) return null;
  const value = number(row.asn);
  if (value == null || !Number.isInteger(value) || value <= 0) {
    throw new Error("服务器上报的 asn 必须是正整数或 null");
  }
  return value;
}

const IPV4 =
  /^(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

function requiredIp(row: Record<string, unknown>): string {
  const value = requiredText(row, "publicIp");
  if (!IPV4.test(value)) throw new Error("服务器上报的 publicIp 必须是 IPv4");
  return value;
}

/**
 * 把上报器的报文收敛成对外契约。
 *
 * 字节、秒、百分比都进字段名（AGENTS.md 第 4 条）。站点不替上报器做单位换算：
 * `/proc` 读出来是什么，上报器转完再发。
 */
export function normalizeServer(input: unknown): ServerStatus {
  const row = object(input);
  if (!row) throw new Error("服务器上报必须是 JSON 对象");
  if (row.version !== 1) throw new Error("服务器上报的 version 必须为 1");

  const memoryTotalBytes = requiredPositive(row, "memoryTotalBytes");
  const memoryUsedBytes = requiredNumber(row, "memoryUsedBytes");
  const memoryAvailableBytes = requiredNumber(row, "memoryAvailableBytes");
  if (memoryUsedBytes > memoryTotalBytes) {
    throw new Error("服务器上报的 memoryUsedBytes 不能大于 memoryTotalBytes");
  }
  if (memoryAvailableBytes > memoryTotalBytes) {
    throw new Error("服务器上报的 memoryAvailableBytes 不能大于 memoryTotalBytes");
  }

  const diskTotalBytes = requiredPositive(row, "diskTotalBytes");
  const diskUsedBytes = requiredNumber(row, "diskUsedBytes");
  if (diskUsedBytes > diskTotalBytes) {
    throw new Error("服务器上报的 diskUsedBytes 不能大于 diskTotalBytes");
  }

  const observedAt = requiredPositive(row, "observedAt");
  if (!Number.isInteger(observedAt)) {
    throw new Error("服务器上报的 observedAt 必须是 epoch 毫秒整数");
  }

  const cpuCores = requiredPositive(row, "cpuCores");
  if (!Number.isInteger(cpuCores)) {
    throw new Error("服务器上报的 cpuCores 必须是正整数");
  }

  return {
    id: requiredText(row, "id"),
    hostname: requiredText(row, "hostname"),
    publicIp: requiredIp(row),
    country: nullableText(row, "country"),
    city: nullableText(row, "city"),
    isp: nullableText(row, "isp"),
    asn: nullableAsn(row),
    asnOrg: nullableText(row, "asnOrg"),
    os: requiredText(row, "os"),
    kernel: requiredText(row, "kernel"),
    cpuCores,
    cpuUsagePercent: requiredPercent(row, "cpuUsagePercent"),
    load1: Math.round(requiredNumber(row, "load1") * 100) / 100,
    load5: Math.round(requiredNumber(row, "load5") * 100) / 100,
    load15: Math.round(requiredNumber(row, "load15") * 100) / 100,
    memoryTotalBytes,
    memoryUsedBytes,
    memoryAvailableBytes,
    diskTotalBytes,
    diskUsedBytes,
    networkInterface: requiredText(row, "networkInterface"),
    networkRxBytes: requiredNumber(row, "networkRxBytes"),
    networkTxBytes: requiredNumber(row, "networkTxBytes"),
    networkRxBytesPerSec: Math.round(requiredNumber(row, "networkRxBytesPerSec")),
    networkTxBytesPerSec: Math.round(requiredNumber(row, "networkTxBytesPerSec")),
    uptimeSeconds: Math.round(requiredNumber(row, "uptimeSeconds")),
    observedAt,
  };
}
