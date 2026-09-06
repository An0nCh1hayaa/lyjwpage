import { chargerPushPayload } from "@/lib/anker";
import { readChargerState } from "@/lib/charger-store";
import {
  normalizeChargingDevice,
  normalizePowerBank,
  pickCharger,
  pickPowerBank,
  type RawChargingDevices,
} from "@/lib/charging-device";
import { askSettlingAt, settlingDecision } from "@/lib/charging-settling";
import {
  getHomePodSnapshot,
  playableHomePod,
  type StoredHomePod,
} from "@/lib/homepod-store";
import { number, object, text } from "@/lib/json";
import { CHARGER_TAG, DESKTOP_TAG, NOW_LISTENING_TAG, POWERBANK_TAG, TIMEZONE_TAG, VIBECODING_TAG, VIBECODING_YEAR_TAG, type LiveEvent } from "@/lib/live-events";
import { pickNowListening } from "@/lib/now-listening";
import {
  normalizePlayingQueue,
  upcomingQueueTracks,
  type PlayingQueueTrack,
} from "@/lib/playing-queue";
import { powerBankPushPayload } from "@/lib/powerbank";
import { readPowerBankState } from "@/lib/powerbank-store";
import { IMAGE_OBJECT_KEY } from "@/lib/r2-assets";
import { nextLiveness, readLiveness, type Liveness } from "@/lib/reporter-liveness";
import type {
  LocalNowPlaying,
  TimezoneActivity
} from "@/lib/types";
import { fanout, type PendingEvent } from "@ingest/fanout";
import { putAppleMusicCredentials } from "@ingest/stores/apple-music-credentials";
import { prepareHeartbeat, prepareStatus } from "@ingest/stores/charger-store";
import { writeSettlingAt } from "@ingest/stores/charging-settling";
import { prepareStatus as preparePowerBankStatus } from "@ingest/stores/powerbank-store";
import { writeLiveness } from "@ingest/stores/reporter-liveness";
import { prepareVibeCodingNow, prepareVibeCodingUsage } from "@ingest/stores/vibecoding";
import { prepareVibeCodingYear } from "@ingest/stores/vibecoding-year-store";
import { DESKTOP_ICON_CACHE_LIMIT, desktopPayload, mirror, type PersistedTelemetry, snapshotFrom, type StoredDesktopActivity, syncTelemetryState, telemetryState } from "@shared/telemetry";

type TelemetryPatch = {
  desktop?: StoredDesktopActivity | null;
  desktopIconAssets?: [string, string][];
  timezone?: TimezoneActivity | null;
  music?: LocalNowPlaying | null;
  upcomingTracks?: PlayingQueueTrack[];
};

async function persistTelemetryState(
  receivedAt: number,
  patch: TelemetryPatch,
  activeModules: string[],
) {
  const incoming: PersistedTelemetry = {
    desktop: "desktop" in patch ? (patch.desktop ?? null) : telemetryState.desktop,
    desktopIconAssets:
      patch.desktopIconAssets ?? [...telemetryState.desktopIconAssets],
    timezone: "timezone" in patch ? (patch.timezone ?? null) : telemetryState.timezone,
    music: "music" in patch ? (patch.music ?? null) : telemetryState.music,
    upcomingTracks:
      "upcomingTracks" in patch ? (patch.upcomingTracks ?? []) : telemetryState.upcomingTracks,
    activityReceivedAt:
      "desktop" in patch || "music" in patch
        ? receivedAt
        : telemetryState.activityReceivedAt,
    timezoneReceivedAt: "timezone" in patch ? receivedAt : telemetryState.timezoneReceivedAt,
    telemetryReceivedAt: receivedAt,
    activeModules,
  };

  const fields: (keyof PersistedTelemetry & string)[] = ["telemetryReceivedAt", "activeModules"];
  if ("desktop" in patch) fields.push("desktop", "desktopIconAssets", "activityReceivedAt");
  else if ("desktopIconAssets" in patch) fields.push("desktopIconAssets");
  if ("timezone" in patch) fields.push("timezone", "timezoneReceivedAt");
  if ("music" in patch) fields.push("music", "upcomingTracks", "activityReceivedAt");

  await mirror.merge(incoming, fields);
}

type TelemetryEnvelope = {
  presence?: unknown;
  version?: unknown;
  heartbeatAt?: unknown;
  activeModules?: unknown;
  modules?: unknown;
};

function milliseconds(value: unknown, fallback = Date.now()) {
  const parsed = number(value);
  if (parsed == null) return fallback;
  return parsed > 1e12 ? parsed : parsed * 1000;
}

/** Map 的插入顺序顺便充当 LRU；每次命中或更新都把该项移到末尾。 */
function rememberDesktopIcon(hash: string, objectKey: string) {
  telemetryState.desktopIconAssets.delete(hash);
  telemetryState.desktopIconAssets.set(hash, objectKey);
  if (telemetryState.desktopIconAssets.size > DESKTOP_ICON_CACHE_LIMIT) {
    const oldest = telemetryState.desktopIconAssets.keys().next().value;
    if (oldest !== undefined) telemetryState.desktopIconAssets.delete(oldest);
  }
}

async function normalizeDesktop(
  value: unknown,
  receivedAt: number,
): Promise<{ activity: StoredDesktopActivity | null; iconAvailable: boolean }> {
  const row = object(value);
  if (!row) return { activity: null, iconAvailable: true };
  const applicationName = text(row.applicationName);
  if (!applicationName) throw new Error("desktop 模块缺少 applicationName");
  const bundleIdentifier = text(row.bundleIdentifier);
  const iconHash = text(row.iconHash);
  if (iconHash != null && !/^[a-f0-9]{64}$/.test(iconHash)) {
    throw new Error("desktop.iconHash 必须是 SHA-256 十六进制字符串");
  }
  /**
   * 两个哈希各司其职，不是同一个东西，别再把它们对等起来。
   *
   * - `iconHash` 是**这个应用的图标**的身份：应用有图标它就非空，哪怕编码失败、
   *   还没传上去。站点靠它当 desktopIconAssets 的键。
   * - `iconObjectKey` 是**已经躺在 R2 里的那份字节**的内容地址，直传成功才有。
   *
   * 从前两者都取自压缩后的字节，于是「这个应用没有图标」和「图标没准备好」
   * 都表现为 iconHash 为空 —— 下面的 iconAvailable 把后者也当成了「一切正常」，
   * 上报器再也收不到补传信号。实测因此静默丢了整整一批图标。
   */
  const iconObjectKey = text(row.iconObjectKey);
  if (iconObjectKey != null && !IMAGE_OBJECT_KEY.test(iconObjectKey)) {
    throw new Error("desktop.iconObjectKey 必须是 <sha256>.png 或 <sha256>.webp");
  }
  if (iconObjectKey != null && iconHash == null) {
    throw new Error("desktop.iconObjectKey 必须和 iconHash 一起上报");
  }

  if (row.iconData != null) throw new Error("desktop.iconData 已停用，请由上报器直传 R2");

  // 上报器一次性编好小图并直传 R2，只把对象键发回来。对象键落 Redis，URL
  // 到读取/推送时才按当前部署的 R2_PUBLIC_BASE_URL 组，避免写入方烧死交付域名。
  //
  // 站点不在名称上报的热路径里 HEAD：上报器在后台 resolver 里先查后写，
  // 并按五分钟窗口复验，桶被清空时由它原地补回同一个内容地址。这里信任它
  // 已确认的对象键，避免图片存储的一次慢响应拖住整次前台切换。
  if (iconObjectKey && iconHash) {
    rememberDesktopIcon(iconHash, iconObjectKey);
  }

  const storedIconObjectKey = iconHash
    ? (telemetryState.desktopIconAssets.get(iconHash) ?? null)
    : null;
  if (iconHash && storedIconObjectKey) rememberDesktopIcon(iconHash, storedIconObjectKey);
  return {
    activity: {
      applicationName,
      bundleIdentifier,
      iconObjectKey: storedIconObjectKey,
      observedAt: milliseconds(row.observedAt, receivedAt),
    },
    iconAvailable: iconHash == null || storedIconObjectKey != null,
  };
}

function normalizeTimezone(
  value: unknown,
  receivedAt: number,
): TimezoneActivity | null {
  const row = object(value);
  if (!row) return null;
  const identifier = text(row.identifier);
  if (!identifier) return null;
  return {
    identifier,
    abbreviation: text(row.abbreviation),
    secondsFromGMT: Math.trunc(number(row.secondsFromGMT) ?? 0),
    observedAt: milliseconds(row.observedAt, receivedAt),
  };
}

async function normalizeMusic(
  value: unknown,
  receivedAt: number,
): Promise<LocalNowPlaying | null> {
  const row = object(value);
  if (!row) return null;
  const rawState = text(row.state);
  const state = rawState === "playing" || rawState === "paused" ? rawState : "stopped";
  const trackId = text(row.trackId);
  return {
    source: "apple-music",
    state,
    title: text(row.title),
    artist: text(row.artist),
    album: text(row.album),
    trackId,
    // 采集端不再上传封面二进制：读取时会查一次 Apple Music 目录拿曲目链接，
    // 那次查询的结果自带封面 URL，见 getNowListening
    artworkUrl: null,
    positionMs: Math.max(0, number(row.positionMs) ?? 0),
    durationMs: Math.max(0, number(row.durationMs) ?? 0),
    // 上报器发的是布尔值，字符串那支是给旧版采集器留的；缺字段按「不循环」处理
    repeatOne: text(row.repeatOne) === "true" || row.repeatOne === true,
    observedAt: milliseconds(row.observedAt, receivedAt),
  };
}

function upcomingFromMusicRow(row: Record<string, unknown>, title: string | null) {
  return upcomingQueueTracks(normalizePlayingQueue(row.queue), title);
}

/**
 * Mac 上报器的唯一入口。
 *
 * 一个 envelope 可以只更新一个模块，未出现的模块保持原快照；modules 整个省略
 * （或给个空对象）就是一次纯心跳 —— 靠 presence 和 heartbeatAt 起作用。
 *
 * 从前心跳和优雅下线走另一个 presence 端点，于是「上报器还活着」这一件事有
 * 两份实现，连记账顺序都是各排各的（一个先 declare 后 mark，一个反过来）。
 * 现在只有这一条路：每条信封都刷新存活，声明翻转时发一次 presence 事件。
 */
export async function recordTelemetryEnvelope(input: unknown, receivedAt = Date.now()) {
  // 校验排在任何 I/O 之前：纯计算，不值得为一封写坏的报文先跑一趟 Redis
  const envelope = object(input) as TelemetryEnvelope | null;
  if (!envelope || envelope.version !== 4) throw new Error("遥测协议 version 必须为 4");
  if (number(envelope.heartbeatAt) == null) throw new Error("遥测请求缺少 heartbeatAt");
  if (!Array.isArray(envelope.activeModules)) throw new Error("遥测请求缺少 activeModules");
  const nextActiveModules = envelope.activeModules.filter(
    (value): value is string => typeof value === "string",
  );
  if (nextActiveModules.length !== envelope.activeModules.length) {
    throw new Error("activeModules 只能包含字符串");
  }
  const presence = text(envelope.presence);
  if (presence !== "online" && presence !== "offline") {
    throw new Error("遥测请求的 presence 必须是 online 或 offline");
  }
  /**
   * modules 省略或为空 = 纯心跳。
   *
   * 只有「给了但不是对象」才算写坏 —— 那是上报器组包出了错，不能默默当成心跳
   * 收下，否则真实的模块数据丢了也没人知道。
   */
  if (envelope.modules != null && !object(envelope.modules)) {
    throw new Error("遥测请求的 modules 必须是对象");
  }
  const modules = object(envelope.modules) ?? {};
  // 三份 coding 快照必须全部合法才允许开始写。否则 year 写坏时，usage / now
  // 已经调用 commit，会在返回 400 的同时留下半份更新。
  const codingUsage = "vibeCodingUsage" in modules
    ? prepareVibeCodingUsage(modules.vibeCodingUsage, receivedAt)
    : null;
  const codingNow = "vibeCodingNow" in modules
    ? prepareVibeCodingNow(modules.vibeCodingNow, receivedAt)
    : null;
  const codingYear = "vibeCodingYear" in modules
    ? prepareVibeCodingYear(modules.vibeCodingYear, receivedAt)
    : null;

  /**
   * 这封信封用得着的键，**全部在这里一起发车**。
   *
   * 同一条 ioredis 连接上并发发出的命令在网络上是重叠的，所以这几条加起来
   * 只花一个来回 —— 不用真去组 pipeline。关键是「决定读什么」必须早于
   * 「分发模块」：从前充电头那两条读是分支里现读的，于是它排在状态和存活
   * 后面，一封带充电头的信封要三个背靠背的来回才轮到推送。
   *
   * 只读这封用得上的：`charger:history` 是 400 个采样点、十几 KB，无条件读回来
   * 再丢掉，比多一个来回还亏。
   */
  const hasChargingDevices = "chargingDevices" in modules;
  const wantsCharger = hasChargingDevices || nextActiveModules.includes("charger");
  const charger = wantsCharger ? readChargerState() : null;
  /**
   * 两台设备各自的「上一次结构变化在什么时候」，收敛窗口要用（lib/charging-settling）。
   * 结构真变了的话这两条是白读的，但它们和上面几条在同一批里，不多花来回。
   */
  const settling = hasChargingDevices
    ? { charger: askSettlingAt("charger"), powerbank: askSettlingAt("powerbank") }
    : null;
  const powerBank = hasChargingDevices ? readPowerBankState() : null;
  const homePod = "appleMusic" in modules ? getHomePodSnapshot() : null;
  const [, previousLiveness] = await Promise.all([syncTelemetryState(), readLiveness()]);

  // 落 activeModules 必须排在 syncTelemetryState 后面 —— 它会从库里那份覆盖回来
  telemetryState.activeModules = new Set(nextActiveModules);
  /**
   * envelope.presence 是上报器声明的在离线。
   *
   * 只覆盖优雅离开：退出、睡眠时它抢在断开前发一条 offline，这里立刻把状态
   * 翻过去，不用等心跳窗口。崩溃、断网、强制关机时它发不出这一条，
   * 那些仍然靠 offlineByLiveness 里的心跳窗口兜底 —— 两条路是互补的。
   *
   * 任何一条信封本身都算一次在线心跳；offline 只用于睡眠、退出这类优雅离开。
   */
  const { next: liveness, flipped: presenceFlipped } = nextLiveness(previousLiveness, {
    offline: presence === "offline",
    at: receivedAt,
  });

  /**
   * 这一轮要做的三件事，收集起来一起交给 fanout：写和推同时发车，缓存失效排在
   * 它们之后。先后为什么必须是这样，见 lib/live-events 的 fanout。
   *
   * 从前是逐个 await：每一次推送前面都压着一串 Redis 往返，而推送本身要的东西
   * 这时早就在手上了。
   */
  const writes: Promise<unknown>[] = [];
  const events: PendingEvent[] = [];
  const notify: PendingEvent[] = [];
  const tags: string[] = [];
  const urgentTags: string[] = [];

  let accepted = 0;
  let desktopIconAvailable: boolean | undefined;
  let chargerCoverIconAvailable: boolean | undefined;
  const patch: TelemetryPatch = {};

  /**
   * 存活第一个发车，而且排在模块处理**外面**。
   *
   * 「任何一条信封本身都算一次在线心跳」—— 哪怕其中一个模块写坏了。放进下面
   * 那个 try 里的话，上报器一旦带出个格式错误，每封都 400、每封都不记心跳，
   * 90 秒后整台 Mac 的卡全变灰，而它其实活得好好的、别的模块也还在正常落库。
   * 从前 recordReporterBeat 就排在模块前面，这里保持不变。
   */
  writes.push(writeLiveness(liveness));

  /**
   * 在离线翻转本身就是状态变化，值得推 —— 这正是「关键事件」，不是定时广播。
   *
   * 这一条不带数据，浏览器收到后要回源重取三份（PRESENCE_PATHS：desktop /
   * listening-now / charger），所以它得排在写后面，交给 fanout 的 `notify`。
   * 时区不看存活，上下线不用刷它的首屏缓存。
   *
   * 这几行排在模块处理**外面**，和上面那次心跳同一个理由：翻转是这封信封确实
   * 带来的变化，哪怕其中一个模块写坏了也已经写进存活里了，浏览器不该只能等下一轮
   * 轮询才翻过来 —— fanout 的失效和通知都在 `finally` 里，写抛出去也照发。
   */
  if (presenceFlipped) {
    notify.push({ type: "presence", payload: null });
    tags.push(DESKTOP_TAG);
    urgentTags.push(NOW_LISTENING_TAG, CHARGER_TAG);
  }

  /**
   * 模块处理整个包起来，是为了保证「已经发车的写」一定被交给 fanout。
   *
   * 下面的写是 push 进 writes 就开跑的，而后面的模块还可能校验失败抛出去 ——
   * 中途 return 的话，那几个已经发车的写就没人接管了，serverless 上响应一返回
   * 随手就被掐掉，表现是「上报器报了个格式错误，顺带丢了同一封里已经收下的
   * 另外几份数据」。错误照样往上抛，只是先把该落的交出去。
   *
   * 注意等它们的不再是这一层：fanout 走 after()，写和推送都在响应之后跑
   * （见 lib/live-events 的 afterResponse），保住它们的是平台的 waitUntil。
   */
  try {
    /**
     * 充电设备。
     *
     * 上报器 v5 起送的是 `chargingDevices`：一个设备列表，充电头和充电宝在同一个
     * 数组里，靠 `kind` 区分。两台各自落库、各自推送 —— 一台没在列表里不影响另
     * 一台，那正是「只开了其中一个模块」的正常情况。
     *
     * 旧的 `charger` 键已经停发。这里不做兼容：留一条读不到新字段的旧路径，只会
     * 在上报器回滚时安静地写进半截数据。
     */
    let chargerWritten = false;
    if ("chargingDevices" in modules) {
      const raw = object(modules.chargingDevices) as RawChargingDevices | null;
      if (!raw) throw new Error("chargingDevices 模块必须是对象");

      const device = pickCharger(raw);
      // 只开了充电宝模块时列表里就没有充电头。那不是错误，收下心跳即可。
      if (device) {
        if (!device.updatedAt) throw new Error("chargingDevices 里的充电头缺少 updatedAt");
        let status = normalizeChargingDevice(device);
        if (status.cover?.iconHash && status.cover.iconObjectKey) {
          rememberDesktopIcon(status.cover.iconHash, status.cover.iconObjectKey);
        }
        if (status.cover?.iconHash) {
          const storedKey = telemetryState.desktopIconAssets.get(status.cover.iconHash) ?? null;
          if (storedKey) rememberDesktopIcon(status.cover.iconHash, storedKey);
          status = {
            ...status,
            cover: { ...status.cover, iconObjectKey: storedKey },
          };
        }
        chargerCoverIconAvailable =
          status.cover?.iconHash == null || status.cover.iconObjectKey != null;
        if (status.cover?.iconHash) {
          patch.desktopIconAssets = [...telemetryState.desktopIconAssets];
        }
        // 上面早就发车了，这里只是把它接住
        const landing = prepareStatus(status, receivedAt, await (charger ?? readChargerState()));
        writes.push(landing.commit());
        chargerWritten = true;
        /**
         * 插拔、换设备立刻推给浏览器，不等卡片下一次轮询。滚动读数照旧不走这里 ——
         * 除了插拔后那几十秒：采集端在那段时间会追发，功率还在往稳定值收敛，
         * 那几帧值得推。窗口的判断见 lib/charging-settling。
         */
        const window = settlingDecision(
          landing.structuralChanged,
          receivedAt,
          await (settling?.charger ?? askSettlingAt("charger")),
        );
        if (window.restart) writes.push(writeSettlingAt("charger", receivedAt));
        if (window.publish) {
          events.push({
            type: "charger",
            payload: chargerPushPayload({
              status,
              receivedAt,
              historyCount: landing.historyCount,
              liveness,
            }),
          });
          urgentTags.push(CHARGER_TAG);
        }
      }

      const bank = pickPowerBank(raw);
      if (bank) {
        if (!bank.updatedAt) throw new Error("chargingDevices 里的充电宝缺少 updatedAt");
        const status = normalizePowerBank(bank);
        const landing = preparePowerBankStatus(
          status,
          receivedAt,
          await (powerBank ?? readPowerBankState()),
        );
        writes.push(landing.commit());
        // 和充电头同一套：插拔、充放电切换、热控翻转、整数电量跳格即时推，加上
        // 插拔之后那段收敛窗口；缓慢滚动的电量和功率仍然等下一次轮询。
        const window = settlingDecision(
          landing.structuralChanged,
          receivedAt,
          await (settling?.powerbank ?? askSettlingAt("powerbank")),
        );
        if (window.restart) writes.push(writeSettlingAt("powerbank", receivedAt));
        if (window.publish) {
          events.push({
            type: "powerbank",
            payload: powerBankPushPayload({ status, receivedAt, liveness }),
          });
          urgentTags.push(POWERBANK_TAG);
        }
      }
      accepted += 1;
    }
    /**
     * 充电头按「多久没收到推送」判断断流，纯心跳也得给它续上。
     *
     * 上面真收下快照时不用再来一次：prepareStatus 那条 pipeline 里已经把这个心跳
     * 一起落了。从前两条都发，于是每个带充电头的信封都白跑一次写加两次读。
     */
    if (!chargerWritten && charger && nextActiveModules.includes("charger")) {
      writes.push(prepareHeartbeat(receivedAt, await charger).commit());
    }

    if ("desktop" in modules) {
      const normalized = await normalizeDesktop(modules.desktop, receivedAt);
      desktopIconAvailable = normalized.iconAvailable;
      // 名字立刻推。图标没就位也推 —— 卡着不发的话页头会停在上一个应用，
      // 比短暂的占位符更糟。desktopIconAvailable 仍然回给上报器，让它补图。
      telemetryState.desktop = normalized.activity;
      telemetryState.activityReceivedAt = receivedAt;
      patch.desktop = normalized.activity;
      patch.desktopIconAssets = [...telemetryState.desktopIconAssets];
      accepted += 1;
      events.push({ type: "desktop", payload: desktopPayload(liveness) });
      tags.push(DESKTOP_TAG);
    }

    if ("timezone" in modules) {
      telemetryState.timezone = normalizeTimezone(modules.timezone, receivedAt);
      telemetryState.timezoneReceivedAt = receivedAt;
      patch.timezone = telemetryState.timezone;
      // 没有对应的推送事件（时区一年变两次，不值得为它开一路广播），
      // 但首屏那份缓存得知道自己过期了 —— 失效是白给的，广播才是按人头付钱的
      tags.push(TIMEZONE_TAG);
      accepted += 1;
    }

    if ("appleMusic" in modules) {
      const musicRow = object(modules.appleMusic);
      const music = await normalizeMusic(modules.appleMusic, receivedAt);
      const upcomingTracks = musicRow ? upcomingFromMusicRow(musicRow, music?.title ?? null) : [];
      telemetryState.music = music;
      telemetryState.upcomingTracks = upcomingTracks;
      telemetryState.activityReceivedAt = receivedAt;
      patch.music = music;
      patch.upcomingTracks = upcomingTracks;
      accepted += 1;
      /**
       * 这一份还要现算：曲目链接和封面要查一次 Apple 目录。整个交给 fanout 和
       * 写库并行 —— 慢的是那次目录查询，等它的同时写库正好也在跑。
       * HomePod 那份快照上面已经发车了（另一个 key，这次上报没碰它）。
       */
      events.push(
        listeningEvent(liveness, homePod ?? getHomePodSnapshot(), {
          music,
          receivedAt,
          upcomingTracks,
        }),
      );
      urgentTags.push(NOW_LISTENING_TAG);
    }

    if ("appleMusicCredentials" in modules) {
      const row = object(modules.appleMusicCredentials);
      if (!row) throw new Error("appleMusicCredentials 必须是对象");
      const hasMusicUserToken = "musicUserToken" in row;
      const hasDeveloperToken = "developerToken" in row;
      if (!hasMusicUserToken && !hasDeveloperToken) {
        throw new Error("appleMusicCredentials 至少包含一个 token");
      }

      const musicUserToken = hasMusicUserToken ? text(row.musicUserToken) : undefined;
      const developerToken = hasDeveloperToken ? text(row.developerToken) : undefined;
      if (hasMusicUserToken && !musicUserToken) throw new Error("musicUserToken 不能为空");
      if (hasDeveloperToken && !developerToken) throw new Error("developerToken 不能为空");

      const expiresAt = hasDeveloperToken ? number(row.expiresAt) : undefined;
      if (hasDeveloperToken && (expiresAt == null || !Number.isFinite(expiresAt) || expiresAt <= 0)) {
        throw new Error("developerToken 必须带有效的 expiresAt");
      }
      writes.push(
        putAppleMusicCredentials({
          // 上面几道守卫已经保证「带了这个字段就一定非空」，但 text() 的返回类型是
          // string | null，TS 收窄不到这一步，只能把 null 折成 undefined
          musicUserToken: musicUserToken ?? undefined,
          developerToken: developerToken ?? undefined,
          expiresAt: expiresAt ?? undefined,
          receivedAt,
        }),
      );
      accepted += 1;
    }

    /**
     * Vibe coding 两个模块各收各的，按「多久变一次」分：
     * `vibeCodingUsage` 是十几分钟一份的累计量，`vibeCodingNow` 是 60 秒一轮的
     * 此刻状态，只有后者值得推给浏览器。理由见 lib/vibecoding 的模块注释。
     *
     * 两份拼成同一张首屏卡片，所以哪一份进来都让同一个缓存 tag 失效，
     * 重复失效是幂等的。三份 coding 模块已经在入口一起校验，这里只提交。
     */
    if (codingUsage) {
      writes.push(codingUsage.commit());
      tags.push(VIBECODING_TAG);
      accepted += 1;
    }

    if (codingNow) {
      const { now, commit } = codingNow;
      writes.push(commit());
      events.push({ type: "vibecoding-now", payload: now });
      tags.push(VIBECODING_TAG);
      accepted += 1;
    }

    /**
     * 年度热力图单独一块。不推送 —— 格子按天变，浏览器长间隔和切回焦点来问。
     * 上报和 GET 都是整年 371 个数一次给齐，云端补回的旧日也会刷新。
     */
    if (codingYear) {
      writes.push(codingYear.commit());
      tags.push(VIBECODING_YEAR_TAG);
      accepted += 1;
    }

    // 整封都收下了才落状态。中途抛出去时这份不写 —— 从前也是这样，
    // persistTelemetryState 就排在所有模块之后。存活不同，见上面。
    // 只 HSET 这封碰过的字段：心跳和换歌并发时，整包 SET 会把 Redis 里的新歌盖回上一首。
    writes.push(persistTelemetryState(receivedAt, patch, nextActiveModules));
  } finally {
    /**
     * 只在模块真的来了才推。
     *
     * 采集端本来就只在内容变化时才带上对应模块，所以「模块出现在 envelope 里」
     * 就是变化信号本身。从前这里是无条件推 —— 连不带任何模块的纯心跳包也推，
     * 为的是把「上报器离线」翻回在线。但过期是时间的函数，两张卡一直在轮询，
     * 那件事轮询本来就在做；为它每 30 秒广播一份没变化的状态，等于把推送当轮询用。
     *
     * 代价是上报器从离线恢复时，「在线」最迟等下一轮轮询（30 秒）才显示，不再是
     * 收到心跳的那一刻。换来的是推送通道上只跑真正的状态变化。
     */
    await fanout({ writes, events, notify, tags, urgentTags });
  }

  return { accepted, heartbeat: true, desktopIconAvailable, chargerCoverIconAvailable };
}

/**
 * 推送当前播放。
 *
 * 暂停宽限期结束时不由这里补一条 —— 从前是挂一个 setTimeout 到点重推，
 * 那要求进程在响应发出之后还活着。serverless 上响应一返回实例就被冻结，
 * 那个定时器根本不会执行，表现是暂停后 hero 一直挂到下一次轮询才翻。
 *
 * 现在改成 payload 自带 expiresInMs，由浏览器把下一次取数排在那一刻，
 * 服务端只对「收到上报」这一件事做出反应，不欠任何未来的动作。
 *
 * `homePod` 收的是一个还没落地的读 —— 调用方在信封解析完就把它发车了，这里
 * 只负责接住。HomePod 那条入口传的则是刚收下的那份（`Promise.resolve`）：那正是
 * 它自己要写的 key，读回来只会更慢，还可能读到写之前的。
 */
async function listeningEvent(
  liveness: Liveness,
  homePod: Promise<StoredHomePod | null>,
  mac?: {
    music: LocalNowPlaying | null;
    receivedAt: number;
    upcomingTracks?: PlayingQueueTrack[];
  },
): Promise<LiveEvent> {
  return {
    type: "listening-now",
    payload: pickNowListening(await snapshotFrom(await homePod, mac), liveness),
  };
}

/**
 * HomePod 那条入口的推送。
 *
 * Mac 那份工作副本要现同步一次（另一个 key，这次上报没碰），存活也要现读；
 * 两个都是读，一起发车。
 */
export async function homePodListeningEvent(stored: StoredHomePod): Promise<LiveEvent> {
  const [, liveness] = await Promise.all([syncTelemetryState(), readLiveness()]);
  return listeningEvent(liveness, Promise.resolve(playableHomePod(stored)));
}
