#!/usr/bin/env python3
"""把这台机器的 CPU / 内存 / 磁盘 / 网速推给 lyjwpage。

只依赖 Python 3 标准库。采集窗口就是上报间隔本身：上一轮 /proc 的读数留着，
这一轮做差，得到的是这段时间的平均占用和平均速率，不是「这一瞬间的尖峰」。
"""

from __future__ import annotations

import fcntl
import json
import os
import re
import signal
import socket
import struct
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any

# 三档节奏。这份快照每轮必发（它本身就是心跳），30 秒一轮时它是站点函数调用量
# 最大的一条路径 —— 实测 12 小时 1.5K 次。而这些数字只在有人看的时候才有人看，
# 所以每轮收尾问一次 ingest Worker 的 /count，拿到两个数，据此决定下一轮多久：
#
#   有人正看着（`online`，只数**可见**的页面）                      → 60 秒
#   页面开着但都在后台（`connections`，数**开着**的连接）           → 2 分钟
#   一个页面都没开                                                  → 15 分钟
#
# 中间那档是为「切走了但还会切回来」留的：手机锁屏、后台标签页在 `online`
# 里算 0（站点侧 use-online-count 在 visibilitychange 时整条关掉），但它随时会
# 被切回来，那一下不该看见十分钟前的 CPU。而事件推送那条连接不管可不可见都挂
# 着，正好是「开着本站」的口径。
#
# 三档和另外两个上报器逐档对齐（agent-limits-reporter、playstation-reporter），
# 同一个概念同一个数，别在三处各调各的。
#
# 慢档锚着站点的 SERVER_STALE_MS（lib/freshness，50 分钟 = 三轮 + 一个刷新周期的
# 余量）：改慢档必须同步改那边，改另外两档不用，判活的下限始终由慢档定。
# 卡片那侧仍是 30 秒一问（和充电头一档），比快档还勤 —— 多出来那一趟拿到的是同
# 一份数字，是有意留的：那是浏览器自己的节奏，不该由上报器的档位决定。
LIVE_INTERVAL_MS = 60_000
OPEN_INTERVAL_MS = 120_000
IDLE_INTERVAL_MS = 900_000
# 人头数读不回来不该拖着上报等。超时、非 200、形状不对，一律当 0 —— 兜底方向
# 是单向的：读不到只会往慢里退，永远不会因为故障变快。
COUNT_TIMEOUT_S = 2.5
PUSH_TIMEOUT_S = 10.0
GEO_TTL_S = 6 * 3600
GEO_TIMEOUT_S = 5.0
USER_AGENT = "lyjwpage-server-reporter/1.0"
AS_LINE = re.compile(r"^AS(\d+)\s*(.*)$", re.IGNORECASE)


# ── 配置 ──────────────────────────────────────────────────


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"缺少环境变量 {name}")
    return value


def ms(name: str, fallback: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return fallback
    try:
        value = int(raw)
    except ValueError as error:
        raise SystemExit(f"{name} 必须是正整数") from error
    if value <= 0:
        raise SystemExit(f"{name} 必须是正整数")
    return value


def trim_slash(url: str) -> str:
    return url.rstrip("/")


def ingest_url() -> str:
    explicit = os.environ.get("SITE_INGEST_URL", "").strip()
    if explicit:
        return explicit
    return f"{trim_slash(required('SITE_URL'))}/api/ingest/server"


def count_url() -> str:
    """ingest Worker 的 /count，和上报同一个源，路径这边拼 —— 和站点侧的
    NEXT_PUBLIC_LIVE_PUSH_URL、另外两个上报器同一个形状。只配了 SITE_INGEST_URL
    没配 SITE_URL 就读不到，两个数恒为 0。

    ingest Worker 是**一份生产一个**，这里填的是 Vercel 那一份，所以国内那份生产上
    开着的后台页面数不进这个判断。少数了只会让节奏往慢里退，和读不到时同一个
    方向，不会误提速。
    """
    origin = os.environ.get("SITE_URL", "").strip()
    return f"{trim_slash(origin)}/count" if origin else ""


CONFIG = {
    "ingest_url": ingest_url(),
    "secret": os.environ.get("TELEMETRY_INGEST_SECRET", "").strip(),
    "host_id": os.environ.get("HOST_ID", "").strip() or "misaka-jp",
    "location": os.environ.get("HOST_LOCATION", "").strip() or "Tokyo",
    "live_interval_s": ms("LIVE_INTERVAL_MS", LIVE_INTERVAL_MS) / 1000,
    "open_interval_s": ms("OPEN_INTERVAL_MS", OPEN_INTERVAL_MS) / 1000,
    "idle_interval_s": ms("IDLE_INTERVAL_MS", IDLE_INTERVAL_MS) / 1000,
    "count_url": count_url(),
    "count_timeout_s": ms("COUNT_TIMEOUT_MS", int(COUNT_TIMEOUT_S * 1000)) / 1000,
    "push_timeout_s": ms("PUSH_TIMEOUT_MS", int(PUSH_TIMEOUT_S * 1000)) / 1000,
}


# ── 日志 ──────────────────────────────────────────────────
# 和另外两份 Node 上报器同一套规矩：同一个环节连续出错只在第一次和恢复时
# 各说一句，中间每满 10 次再报一次，免得 journal 被同一条「连接被拒绝」刷满。

_streaks: dict[str, int] = {}


def stamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def info(message: str) -> None:
    print(f"{stamp()} {message}", flush=True)


def failure(scope: str, error: BaseException | str) -> None:
    count = _streaks.get(scope, 0) + 1
    _streaks[scope] = count
    reason = str(error)
    if count == 1 or count % 10 == 0:
        extra = f"（连续第 {count} 次）" if count > 1 else ""
        print(f"{stamp()} [{scope}] {reason}{extra}", file=sys.stderr, flush=True)


def recovered(scope: str) -> None:
    if not _streaks.get(scope):
        return
    print(f"{stamp()} [{scope}] 恢复正常", flush=True)
    _streaks.pop(scope, None)


# ── 采集 ──────────────────────────────────────────────────


def read_os() -> str:
    pretty = ""
    try:
        with open("/etc/os-release", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("PRETTY_NAME="):
                    pretty = line.split("=", 1)[1].strip().strip('"')
                    break
    except OSError:
        pass
    return pretty or os.uname().sysname


def cpu_times() -> tuple[int, int]:
    """返回 (idle+iowait, 总 jiffies)。guest 已经含在 user 里，不算进总和。"""
    with open("/proc/stat", encoding="utf-8") as handle:
        parts = handle.readline().split()
    nums = [int(item) for item in parts[1:9]]
    idle = nums[3] + (nums[4] if len(nums) > 4 else 0)
    return idle, sum(nums)


def mem_bytes() -> tuple[int, int, int]:
    info_map: dict[str, int] = {}
    with open("/proc/meminfo", encoding="utf-8") as handle:
        for line in handle:
            key, value, *_rest = line.split()
            info_map[key.rstrip(":")] = int(value) * 1024
    total = info_map["MemTotal"]
    available = info_map["MemAvailable"]
    return total, total - available, available


def disk_bytes(path: str = "/") -> tuple[int, int]:
    stat = os.statvfs(path)
    total = stat.f_frsize * stat.f_blocks
    used = total - stat.f_frsize * stat.f_bfree
    return total, used


def loadavg() -> tuple[float, float, float]:
    with open("/proc/loadavg", encoding="utf-8") as handle:
        parts = handle.readline().split()
    return float(parts[0]), float(parts[1]), float(parts[2])


def uptime_seconds() -> float:
    with open("/proc/uptime", encoding="utf-8") as handle:
        return float(handle.readline().split()[0])


def default_iface() -> str:
    """默认路由那块网卡。lo 和没配地址的虚拟口都不算。"""
    with open("/proc/net/route", encoding="utf-8") as handle:
        next(handle)
        for line in handle:
            fields = line.split()
            if len(fields) >= 2 and fields[1] == "00000000":
                return fields[0]
    raise RuntimeError("找不到默认路由网卡")


def iface_ipv4(iface: str) -> str:
    """默认网卡上的 IPv4。这台落地节点的公网地址就配在这块卡上。"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        packed = struct.pack("256s", iface.encode("utf-8")[:15])
        return socket.inet_ntoa(fcntl.ioctl(sock.fileno(), 0x8915, packed)[20:24])
    finally:
        sock.close()


def http_json(url: str, timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8", errors="replace"))
    if not isinstance(payload, dict):
        raise RuntimeError("geo 接口返回的不是对象")
    return payload


def parse_as(raw: str) -> tuple[int | None, str | None]:
    match = AS_LINE.match(raw.strip())
    if not match:
        return None, None
    org = match.group(2).strip() or None
    return int(match.group(1)), org


def text_or_none(value: object) -> str | None:
    if value is None:
        return None
    trimmed = str(value).strip()
    return trimmed or None


def lookup_ip_sb(ip: str) -> dict[str, Any]:
    row = http_json(f"https://api.ip.sb/geoip/{ip}", GEO_TIMEOUT_S)
    asn_raw = row.get("asn")
    asn = None
    if isinstance(asn_raw, int) and asn_raw > 0:
        asn = asn_raw
    elif isinstance(asn_raw, str) and asn_raw.isdigit():
        parsed = int(asn_raw)
        if parsed > 0:
            asn = parsed
    org = row.get("asn_organization") or row.get("organization")
    isp = row.get("isp") or org
    return {
        "country": text_or_none(row.get("country")),
        "city": text_or_none(row.get("city")),
        "isp": str(isp).strip() if isp else None,
        "asn": asn if asn and asn > 0 else None,
        "asnOrg": str(org).strip() if org else None,
    }


def lookup_ip_api(ip: str) -> dict[str, Any]:
    row = http_json(
        f"http://ip-api.com/json/{ip}?fields=status,message,country,city,isp,org,as",
        GEO_TIMEOUT_S,
    )
    if row.get("status") != "success":
        raise RuntimeError(str(row.get("message") or "ip-api 失败"))
    asn, as_org = parse_as(str(row.get("as") or ""))
    org = as_org or (str(row["org"]).strip() if row.get("org") else None)
    isp = str(row["isp"]).strip() if row.get("isp") else org
    return {
        "country": text_or_none(row.get("country")),
        "city": text_or_none(row.get("city")),
        "isp": isp or None,
        "asn": asn,
        "asnOrg": org,
    }


_geo: dict[str, Any] = {"ip": "", "at": 0.0}


def geo_for(ip: str) -> dict[str, Any]:
    """查 Location / ISP / ASN。结果按 IP 缓存几小时，地址没变就不打上游。"""
    now = time.time()
    if _geo["ip"] == ip and now - _geo["at"] < GEO_TTL_S:
        return _geo

    try:
        found = lookup_ip_sb(ip)
        recovered("geo")
    except Exception as error:
        failure("geo", error)
        try:
            found = lookup_ip_api(ip)
            recovered("geo")
        except Exception as fallback:
            failure("geo", fallback)
            if _geo["ip"] == ip:
                return _geo
            found = {
                "country": None,
                "city": CONFIG["location"] or None,
                "isp": None,
                "asn": None,
                "asnOrg": None,
            }

    _geo.clear()
    _geo.update(found)
    _geo["ip"] = ip
    _geo["at"] = now
    return _geo


def net_bytes(iface: str) -> tuple[int, int]:
    token = f"{iface}:"
    with open("/proc/net/dev", encoding="utf-8") as handle:
        for line in handle:
            stripped = line.lstrip()
            if not stripped.startswith(token):
                continue
            parts = stripped.split()
            # iface: rx_bytes ... tx_bytes 在 split 之后下标 1 和 9
            return int(parts[1]), int(parts[9])
    raise RuntimeError(f"网卡 {iface} 不在 /proc/net/dev 里")


def cpu_percent(prev: tuple[int, int], cur: tuple[int, int]) -> float:
    idle_delta = cur[0] - prev[0]
    total_delta = cur[1] - prev[1]
    if total_delta <= 0:
        return 0.0
    used = 1.0 - idle_delta / total_delta
    return max(0.0, min(100.0, used * 100.0))


def snapshot(
    iface: str,
    prev_cpu: tuple[int, int],
    prev_net: tuple[int, int],
    prev_at: float,
) -> dict[str, Any]:
    now = time.time()
    cur_cpu = cpu_times()
    cur_net = net_bytes(iface)
    elapsed = max(now - prev_at, 1e-6)
    rx, tx = cur_net
    prev_rx, prev_tx = prev_net
    memory_total, memory_used, memory_available = mem_bytes()
    disk_total, disk_used = disk_bytes()
    load1, load5, load15 = loadavg()
    uname = os.uname()
    public_ip = iface_ipv4(iface)
    geo = geo_for(public_ip)
    return {
        "version": 1,
        "id": CONFIG["host_id"],
        "hostname": socket.gethostname(),
        "publicIp": public_ip,
        "country": geo.get("country"),
        "city": geo.get("city") or CONFIG["location"] or None,
        "isp": geo.get("isp"),
        "asn": geo.get("asn"),
        "asnOrg": geo.get("asnOrg"),
        "os": read_os(),
        "kernel": uname.release,
        "cpuCores": os.cpu_count() or 1,
        "cpuUsagePercent": round(cpu_percent(prev_cpu, cur_cpu), 1),
        "load1": round(load1, 2),
        "load5": round(load5, 2),
        "load15": round(load15, 2),
        "memoryTotalBytes": memory_total,
        "memoryUsedBytes": memory_used,
        "memoryAvailableBytes": memory_available,
        "diskTotalBytes": disk_total,
        "diskUsedBytes": disk_used,
        "networkInterface": iface,
        "networkRxBytes": rx,
        "networkTxBytes": tx,
        "networkRxBytesPerSec": max(0, (rx - prev_rx) / elapsed),
        "networkTxBytesPerSec": max(0, (tx - prev_tx) / elapsed),
        "uptimeSeconds": round(uptime_seconds()),
        "observedAt": int(now * 1000),
        "_cursor": {"cpu": cur_cpu, "net": cur_net, "at": now},
    }


# ── 推送 ──────────────────────────────────────────────────


def push(payload: dict[str, Any]) -> None:
    body = json.dumps(
        {key: value for key, value in payload.items() if key != "_cursor"},
        separators=(",", ":"),
    ).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    }
    if CONFIG["secret"]:
        headers["Authorization"] = f"Bearer {CONFIG['secret']}"
    request = urllib.request.Request(
        CONFIG["ingest_url"],
        data=body,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=CONFIG["push_timeout_s"]) as response:
            raw = response.read().decode("utf-8", errors="replace")
            try:
                envelope = json.loads(raw)
            except json.JSONDecodeError as error:
                raise RuntimeError(f"站点返回 {response.status}：不是合法 JSON") from error
            if not isinstance(envelope, dict) or envelope.get("ok") is not True:
                reason = envelope.get("error") if isinstance(envelope, dict) else None
                extra = f"：{reason}" if reason else ""
                raise RuntimeError(f"站点返回 {response.status}{extra}")
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            envelope = json.loads(raw)
            reason = envelope.get("error") if isinstance(envelope, dict) else None
        except json.JSONDecodeError:
            reason = raw[:200]
        extra = f"：{reason}" if reason else ""
        raise RuntimeError(f"站点返回 {error.code}{extra}") from error


# ── 主循环 ────────────────────────────────────────────────


def head_counts() -> tuple[int, int]:
    """问 ingest Worker 要两个人头数 (可见, 开着)。读不到一律当 0，节奏只会因此往慢里退。"""
    url = CONFIG["count_url"]
    # 没配那个变量不是故障，别让它进 failure 的连击计数
    if not url:
        return 0, 0
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=CONFIG["count_timeout_s"]) as response:
            body = json.loads(response.read().decode("utf-8", errors="replace"))
        online = int(body["online"])
        connections = int(body["connections"])
        recovered("head-count")
        return max(online, 0), max(connections, 0)
    except Exception as error:  # noqa: BLE001 — 读不到就是没人看，不影响上报
        failure("head-count", error)
        return 0, 0


def next_delay() -> float:
    """下一轮多久之后。可见 → 快档，只是开着 → 中档，都没有 → 慢档。"""
    online, connections = head_counts()
    if online > 0:
        return CONFIG["live_interval_s"]
    if connections > 0:
        return CONFIG["open_interval_s"]
    return CONFIG["idle_interval_s"]


def wait_for_next_round(stopping: "Callable[[], bool]") -> None:
    """等到下一轮。

    长档不是一觉睡满：拆成一个个快档长度的小觉，每觉醒来重新问一次人头数，
    该走更快那档了就立刻回去开跑。否则「从没人到有人正看着」最坏要等满一个慢档
    （15 分钟），而那正是有人盯着屏幕等的那一刻。多打的那几次是自家的
    ingest Worker，不是这台机器的 /proc。
    """
    delay = next_delay()
    deadline = time.time() + delay
    while not stopping():
        left = deadline - time.time()
        if left <= 0:
            return
        nap = min(CONFIG["live_interval_s"], left)
        napped_until = time.time() + nap
        while not stopping() and time.time() < napped_until:
            time.sleep(min(0.5, napped_until - time.time()))
        if stopping() or time.time() >= deadline:
            return
        if next_delay() < delay:
            return


def main() -> None:
    info(
        f"server-reporter 启动：{CONFIG['host_id']} ({CONFIG['location']}) → {CONFIG['ingest_url']}"
    )
    if not CONFIG["secret"]:
        info("没配 TELEMETRY_INGEST_SECRET —— 只有站点也没配时才可以这样")

    iface = default_iface()
    gears = (
        f"{CONFIG['live_interval_s']:.0f}s / {CONFIG['open_interval_s']:.0f}s"
        f" / {CONFIG['idle_interval_s']:.0f}s"
    )
    info(
        f"网卡 {iface}，间隔 {gears}（有人看 / 开着 / 都没有）"
        + ("" if CONFIG["count_url"] else "，没配 SITE_URL 读不到人头数，只走最慢那档")
    )

    prev_cpu = cpu_times()
    prev_net = net_bytes(iface)
    prev_at = time.time()
    # 先采 1 秒做出第一份，卡片不必干等到一个完整间隔
    time.sleep(1)

    stopping = False

    def stop(signum: int, _frame: object) -> None:
        nonlocal stopping
        stopping = True
        info(f"收到 {signal.Signals(signum).name}，退出")

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    backoff = CONFIG["live_interval_s"]
    while not stopping:
        try:
            payload = snapshot(iface, prev_cpu, prev_net, prev_at)
            cursor = payload["_cursor"]
            push(payload)
            recovered("push")
            prev_cpu = cursor["cpu"]
            prev_net = cursor["net"]
            prev_at = cursor["at"]
            backoff = CONFIG["live_interval_s"]
            # 问人数排在推送之后：站点先拿到这一轮的数，再决定下一轮多久。
            # None = 走正常那条等待（会在等待中途重新问），不是退避
            delay = None
        except Exception as error:  # noqa: BLE001 — 这一轮作废，进程不退
            failure("push", error)
            delay = backoff
            backoff = min(backoff * 2, 5 * 60)

        if delay is None:
            wait_for_next_round(lambda: stopping)
        else:
            # 上一轮出错：按退避表等，这段时间不问人头数（问了也改变不了退避）
            deadline = time.time() + delay
            while not stopping and time.time() < deadline:
                time.sleep(min(0.5, deadline - time.time()))


if __name__ == "__main__":
    main()
