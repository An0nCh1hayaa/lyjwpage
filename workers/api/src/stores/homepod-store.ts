import { createHash } from "node:crypto";

import { numberish, object, text } from "@/lib/json";
import { type StoredHomePod, mirror } from "@shared/homepod-store";

/**
 * 观测时刻，epoch 毫秒。
 *
 * 和 Mac 上报器的 `observedAt` 同名同单位 —— 两个入口喂的是同一个
 * LocalNowPlaying，字段名和单位就不该各说各话。HA 那边的
 * `media_position_updated_at` 是 ISO 串，模板里 `as_timestamp() * 1000` 转好再发。
 */
function observedAt(value: unknown, fallbackAt: number) {
  const parsed = numberish(value);
  if (parsed == null) return fallbackAt;
  // HA 的时钟不准时，不能让浏览器从未来开始推算进度
  return Math.min(parsed, fallbackAt);
}

/**
 * 内网 / 环回地址判定。
 *
 * 这个 URL 会原样发给访客的浏览器去加载，所以指向本地网络的地址既加载不出来，
 * 也等于把内网拓扑透给了访客。除了常见的私有段，还要挡住几个容易漏的：
 * 链路本地 169.254（云元数据就在这一段）、CGNAT 100.64/10（Tailscale 常用）、
 * IPv6 的环回与私有段，以及十进制/十六进制整数形式的 IP。
 */
function isPrivateHost(hostname: string) {
  // URL 里的 IPv6 带方括号，先剥掉
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");

  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }

  if (host.includes(":")) {
    if (host === "::" || host === "::1") return true;
    // fc00::/7 唯一本地，fe80::/10 链路本地
    if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
    if (!mapped) return false;
    return isPrivateHost(mapped[1]);
  }

  const parts = host.split(".");
  if (parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part))) {
    const [a, b] = parts.map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }

  // 单标签主机名（含 2130706433、0x7f000001 这类整数形式的 IP）一律不放行：
  // 公网 CDN 不会长这样，能匹配到的只有内网名字
  return !host.includes(".");
}

function publicArtwork(value: unknown) {
  const raw = text(value);
  if (!raw) return null;
  try {
    const homeAssistantUrl = new URL(raw, "http://home-assistant.invalid");
    const cachedArtwork = homeAssistantUrl.searchParams.get("cache");
    const relativeAppleArtwork =
      cachedArtwork &&
        !cachedArtwork.includes("..") &&
        /^Music\d+\/[A-Za-z0-9_./-]+\.(?:jpe?g|png)$/i.test(cachedArtwork)
        ? `https://is1-ssl.mzstatic.com/image/thumb/${cachedArtwork}/600x600bb.webp`
        : null;
    const candidate = (relativeAppleArtwork ?? cachedArtwork ?? raw)
      .replaceAll("{w}", "600")
      .replaceAll("{h}", "600")
      .replaceAll("{f}", "webp");
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (isPrivateHost(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * 把 Home Assistant 的 rest_command 报文收敛成卡片的共用契约。
 *
 * 字段名和单位跟 Mac 上报器的 appleMusic 模块对齐（positionMs / durationMs /
 * repeatOne / observedAt），两个入口产出的都是 LocalNowPlaying，同一个概念
 * 不该有两套叫法。转换放在 HA 的模板里做 —— 那边本来就要写模板，而站点这侧
 * 一旦按来源分叉，往后每加一个播放来源就多一套字段要记。
 *
 * `entityId` 是 HomePod 独有的：它没有 Apple Music 的 trackId，只能拿实体加
 * 曲目信息哈希出一个身份。
 */
export function normalizeHomePodEvent(
  input: unknown,
  receivedAt = Date.now(),
): StoredHomePod {
  const row = object(input);
  if (!row) throw new Error("HomePod 请求必须是 JSON 对象");

  const rawState = text(row.state)?.toLowerCase();
  // buffering 是播放中的一个瞬时态，归成 stopped 会让曲目在缓冲那几秒从页面消失
  const state =
    rawState === "playing" || rawState === "buffering"
      ? "playing"
      : rawState === "paused"
        ? "paused"
        : "stopped";
  const title = text(row.title);
  const artist = text(row.artist);
  const album = text(row.album);
  const identity = [text(row.entityId), title, artist, album].filter(Boolean).join("\n");

  return {
    music: {
      source: "homepod",
      state,
      title,
      artist,
      album,
      trackId: identity
        ? createHash("sha256").update(identity).digest("hex").slice(0, 24)
        : null,
      artworkUrl: publicArtwork(row.artworkUrl),
      positionMs: Math.max(0, numberish(row.positionMs) ?? 0),
      durationMs: Math.max(0, numberish(row.durationMs) ?? 0),
      // HA 的 media_player.repeat 取值是 off / all / one，模板里判完再发布尔值
      repeatOne: row.repeatOne === true || text(row.repeatOne)?.toLowerCase() === "true",
      observedAt: observedAt(row.observedAt, receivedAt),
    },
    receivedAt,
  };
}

export function writeHomePodEvent(stored: StoredHomePod): Promise<void> {
  return mirror.put(stored);
}
