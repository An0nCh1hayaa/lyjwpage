/** 三个状态源统一的对外数据契约 —— 前端只认这里的类型。 */

export type WatchingItem = {
  id: string;
  /** 剧名（剧集）或片名（电影） */
  title: string;
  /** 「S01E05 · 集标题」之类的副标题，电影为空 */
  subtitle: string;
  /** 0–100 */
  progress: number;
  /** 竖版海报 */
  poster: string | null;
  /** 横版背景图，做卡片底图用 */
  backdrop: string | null;
  type: "Episode" | "Movie" | "Series" | "Other";
  year: number | null;
  /** 直接跳到 Emby 播放页 */
  link: string | null;
  /** 上次播放时间 ISO 字符串 */
  playedAt: string | null;
};

/** PlayStation 最近游玩列表中的一项；图片仍是 PSN 公共 CDN 的原始地址。 */
export type PlaystationGame = {
  titleId: string;
  name: string;
  /** PSN 上游枚举；未知或上游缺席时为 null，不在入库层猜测。 */
  category: string | null;
  playCount: number;
  firstPlayedAt: number | null;
  lastPlayedAt: number | null;
  playDurationMs: number | null;
  imageUrl: string | null;
  /**
   * 这份 entitlement 怎么来的。上游原样保留，已见 `ps_plus` /
   * `none(purchased)` / `other`。缺席为 null，不在入库层猜测。
   * `ps_plus` 表示当前这份是 Plus 会员库权益，不是「这款曾经上过 Plus 目录」。
   */
  service: string | null;
  /** 购买库标成预购。没对上购买库就是 false。 */
  preOrder: boolean;
};

export type PlaystationPlayingPayload = {
  observedAt: number;
  items: PlaystationGame[];
};

export type PlaystationNowPlaying = {
  titleId: string;
  title: string;
  format: string | null;
  launchPlatform: string | null;
  iconUrl: string | null;
};

export type PlaystationPresencePayload = {
  observedAt: number;
  online: boolean;
  /**
   * PSN 上游枚举。已见 `availableToPlay` / `doNotDisturb` / `unavailable`，
   * 头像那颗点按这三档画绿 / 黄 / 灰。缺席不在入库层猜。
   */
  availability: string | null;
  platform: string | null;
  lastOnlineAt: number | null;
  playing: PlaystationNowPlaying | null;
};

export const TROPHY_TYPES = ["platinum", "gold", "silver", "bronze"] as const;
export type TrophyType = (typeof TROPHY_TYPES)[number];

export type TrophyCounts = {
  platinum: number;
  gold: number;
  silver: number;
  bronze: number;
};

export type TrophyProfile = {
  onlineId: string;
  /** PSN 资料头像。不用 personalDetail 里的实名照片。 */
  avatarUrl: string | null;
  plus: boolean;
  level: number;
  tier: number;
  trophyPoint: number;
  levelBasePoint: number;
  levelNextPoint: number;
  /** 当前等级内进度，0–100 */
  levelProgress: number;
  earned: TrophyCounts;
};

export type TrophyGroup = {
  id: string;
  name: string;
  iconUrl: string | null;
  progress: number;
  defined: TrophyCounts;
  earned: TrophyCounts;
};

export type Trophy = {
  id: number;
  type: TrophyType;
  name: string;
  detail: string | null;
  iconUrl: string | null;
  hidden: boolean;
  groupId: string;
  earned: boolean;
  /** 解锁时刻，epoch 毫秒；未解锁为 null */
  earnedAt: number | null;
  /** 全球持有率，0–100 */
  earnedRate: number | null;
};

/**
 * 一个奖杯标题（一款游戏或一个奖杯组）。
 *
 * `npCommunicationId` 是奖杯 API 的键，和游玩列表里的 `titleId`（PPSA…）
 * 不是同一个东西，所以不叫 titleId。两边靠 Worker 走官方
 * `getUserTrophiesForSpecificTitle` 对齐；同一奖杯组可能对应多个 SKU。
 */
export type TrophyTitle = {
  npCommunicationId: string;
  name: string;
  localizedName: string | null;
  titleIds: string[];
  /** 方形奖杯组图标，和 PS App 奖杯列表同一张 */
  iconUrl: string | null;
  platform: string;
  progress: number;
  defined: TrophyCounts;
  earned: TrophyCounts;
  lastUpdatedAt: number | null;
  playDurationMs: number | null;
  playCount: number;
  firstPlayedAt: number | null;
  lastPlayedAt: number | null;
  /** 对齐后的 entitlement；任一 SKU 来自 Plus 库则为 `ps_plus`。 */
  service: string | null;
  preOrder: boolean;
  groups: TrophyGroup[];
  trophies: Trophy[];
};

export type TrophiesPayload = {
  observedAt: number;
  profile: TrophyProfile;
  titles: TrophyTitle[];
};

export type TrophyUnlock = {
  npCommunicationId: string;
  /**
   * 这三个一起就是明细里那一行的坐标（拼法见 trophyRowKey）。带着它，
   * 点「最近解锁」能直接定位到那一行，不必拿奖杯名去猜 —— 同一款游戏里
   * 重名的奖杯本来就有（各奖杯组一份）。
   */
  id: number;
  groupId: string;
  titleName: string;
  trophyName: string;
  type: TrophyType;
  iconUrl: string | null;
  earnedAt: number;
};

/**
 * 首页提要用的一款游戏：进度和四色杯子，不含逐个奖杯。
 */
export type TrophyTitleDigest = {
  npCommunicationId: string;
  name: string;
  localizedName: string | null;
  titleIds: string[];
  progress: number;
  defined: TrophyCounts;
  earned: TrophyCounts;
};

/**
 * 首页提要：等级、合计、最近解锁、各标题进度。不含逐个奖杯，
 * 避免把整份目录塞进首屏 HTML。
 */
export type TrophiesSummaryPayload = {
  observedAt: number;
  profile: TrophyProfile;
  /**
   * 已解锁的四色合计，从 `titles` 逐金属加总 —— **别读 `profile.earned`**。
   * 那个是账号级的数，而 titles 被上报 Worker 的屏蔽名单滤过：两边不同源，
   * 屏蔽名单一非空数字就偏高。profile 里的等级、点数照旧读 profile，
   * 那些本来就是账号级的事实。
   */
  earned: TrophyCounts;
  recent: TrophyUnlock[];
  titles: TrophyTitleDigest[];
};

/**
 * 最近在听的一项。注意这是「资源」而不是单曲 ——
 * /v1/me/recent/played 返回的是专辑、歌单、电台这类容器。
 */
export type ListeningItem = {
  id: string;
  /** 专辑名 / 歌单名 / 电台名 */
  title: string;
  /** 专辑取 artistName，歌单取 curatorName */
  artist: string;
  artwork: string | null;
  link: string | null;
  /**
   * 封面取色，Apple 随 artwork 一起给：bgColor 加 textColor1..4，最多五个。
   *
   * 注意 textColor 是设计来叠在 bgColor 上的 —— 浅色封面配的是近黑，深色封面
   * 配的是浅色。所以不能直接拿来画东西，用之前必须把亮度拉齐，见前端那条彩虹条。
   */
  palette: string[];
  /**
   * 这张专辑 / 歌单所有曲目时长之和，毫秒。
   *
   * **只有列表第一项有**，其余一律 null：算它要顺着 href 再查一次曲目（歌单还
   * 要翻页），十项全算就是十次上游请求，而页面只在 hero 上显示这一个数。
   */
  durationMs: number | null;
};

/**
 * Mac 上报器的存活。源站盖章，之后由浏览器用 Date.now() 接着算。
 *
 * lastSeenAt 是 ingest 收到时的源站钟，不是设备 observedAt。
 * 心跳窗口跟 payload 走，别在浏览器再读一份常量 —— 和充电头的 staleAfterMs 一样。
 */
export type ReporterPresence = {
  lastSeenAt: number;
  /** 上报器亲口声明的离线，只在优雅离开（退出 / 睡眠）时为真 */
  declaredOffline: boolean;
  /** 超过这么久没心跳就算掉线。源站按 HEARTBEAT_WINDOW_MS 现算，默认 5 分钟。 */
  heartbeatWindowMs: number;
  /**
   * 源站在取数出口按自己的钟算的那一次「这会儿离线没有」。
   *
   * 为的是首帧 —— 那一帧浏览器还没有钟（useMountedAt 为 0，见该 hook 的注释），
   * 拿 lastSeenAt 什么也判不出来，于是离线的 Mac 在首屏必然被画成在线，要等
   * 挂载后才翻。它是一个数据字段，服务端预渲染和 hydrate 那一遍读到的是同一个
   * 值，不像钟读数那样会造成水合不一致。
   *
   * 和充电头 withChargerFreshness 把 connected 打成 false 是同一套口径：过期是
   * 时间函数，在取数出口现盖（首页填缓存、API overlay），卡片直接用。
   *
   * 新鲜度因此以取数出口那一刻为准：API 每次现算；首屏那份跟着页面缓存冻住
   * （revalidate 10 分钟、expire 2 小时，见 lib/status-cache）。心跳不触发 tag
   * 失效，所以冻住的那份两个方向都可能差一会儿 —— Mac 悄悄死掉、或者悄悄回来，
   * 都要等下一次重算才反映进首屏。挂载后浏览器自己的钟接着算，加上那一次回源，
   * 差的那点会被纠正回来。
   */
  offlineAtSource: boolean;
};

export type ListeningPayload = {
  items: ListeningItem[];
  /**
   * 源站上一次从 Apple 拉到这份列表的时刻。
   *
   * **不是新鲜度指标，是代数**：这份数据由访客的轮询驱动刷新，没人看时它就停在
   * 那儿，而一份冻住的「最近在听」本身没有错 —— 只是可能漏掉了这段时间在别处的
   * 播放，不该照搬别的卡那套变灰处理。它的用处是挡住晚到的旧数据，见
   * lib/live-freshness。
   */
  fetchedAt: number;
};

/**
 * 由本机遥测应用直接观测到的前台应用。只有应用本身的身份和图标，
 * 不含窗口标题、文件路径、提示词等任何窗口内容。
 */
export type DesktopActivity = {
  applicationName: string;
  bundleIdentifier: string | null;
  iconUrl: string | null;
  observedAt: number;
};

/** Music.app 的本机播放实况，与 Apple Music Web API 的“最近播放”完全独立。 */
export type LocalNowPlaying = {
  source: "apple-music" | "homepod";
  state: "playing" | "paused" | "stopped";
  title: string | null;
  artist: string | null;
  album: string | null;
  trackId: string | null;
  artworkUrl: string | null;
  positionMs: number;
  durationMs: number;
  /**
   * 单曲循环。曲名、艺人、专辑在循环前后完全一样，光靠这些字段分不出
   * 「在循环」和「上游掉线了」，只能由来源明确告知。
   * 前端据此让进度回绕，而不是钉在 100%。
   */
  repeatOne: boolean;
  observedAt: number;
};

/**
 * MacBook 的前台应用。只有这一个来源。
 *
 * 和播放状态拆成两个接口：播放来源可能是 MacBook，也可能是 HomePod，
 * 两者的生命周期、上报路径、过期语义都不一样，绑在一起只会互相牵扯。
 */
export type DesktopPayload = ReporterPresence & {
  desktop: DesktopActivity | null;
  receivedAt: number | null;
};

/** Mac 当前系统时区。只在 timezone 模块启用时展示，不看上报器在不在线。 */
export type TimezoneActivity = {
  /** IANA 时区标识，如 Asia/Singapore */
  identifier: string;
  abbreviation: string | null;
  /** 当前 UTC 偏移，秒 */
  secondsFromGMT: number;
  observedAt: number;
};

export type TimezonePayload = {
  timezone: TimezoneActivity | null;
  /** 缓存填充时刻。时间卡首帧用它画钟，页面里不能 Date.now()。 */
  snapshotAt: number;
};

/** 实时播放。来源可能是 MacBook 的 Music.app，也可能是 HomePod。 */
export type NowListeningPayload = {
  music: LocalNowPlaying | null;
  receivedAt: number | null;
  /** 两个来源都没有可展示的播放 —— 是「没在放」，不是「数据过期」。 */
  idle: boolean;
  /** 与 /api/status/listening 的 items[].id 对应的 Apple Music 资源 ID。 */
  id: string | null;
  /**
   * 那首曲目在 Apple Music 上的地址，读取时现查的，不进设备上报的快照。
   * 目录里能精确匹配上就是直链，匹配不上退回搜索页。
   */
  link: string | null;
  /**
   * 目录里那首**曲子本身**的资源 ID —— 上面那个 `id` 是它所属的专辑 / 歌单，
   * 两个键挨在一起，别拿错。
   *
   * 「一起听」拿它点播：访客用自己的订阅授权之后，MusicKit 按这个 ID 播同一首。
   * 搜不到（本地导入、非目录内容）时是 null，那时按钮不出现 —— 没有可播的东西。
   */
  songId: string | null;
  /**
   * 主人队列里当前曲后面那两首的目录 ID，已经在服务端搜过。
   *
   * 「一起听」拿它们 playNext，换歌时就能 skipToNext 而不是整队重排。
   * 搜不到或 HomePod 没有队列时是空数组。
   */
  upcomingSongIds: string[];
  /**
   * 目录说这首有没有歌词。true 时浏览器才去 `/api/lyrics` 取同步歌词跟着
   * 进度条走；false 一律不发请求。搜不到曲子（songId 为 null）时是 false。
   */
  hasLyrics: boolean;
  /**
   * 这份选择还能成立多久（毫秒）。null = 不会因为单纯的时间流逝而改变。
   *
   * 只有暂停宽限期会给出非 null 值。客户端据此把下一次取数排在到期那一刻，
   * 不要自己拿 music.observedAt 去算 —— 那是设备的时钟，见 pickNowListening。
   */
  expiresInMs: number | null;
};

export type ChargerPort = {
  /** C1 / C2 / C3 */
  id: string;
  /** 该口是否正在输出（≠ 充电器整体是否在线） */
  active: boolean;
  /** 瓦，未输出时为 null */
  power: number | null;
  /** 伏，未输出时为 null */
  voltage: number | null;
  /** 安，未输出时为 null */
  current: number | null;
  /** 设备名，优先 model 再退 vendor，如 "MacBook Pro series" */
  device: string | null;
  /** 快充协议，如 "Apple PD Fast Charging" */
  protocol: string | null;
  /** 线缆能力等级，如 "EPR-240W MAX" */
  cable: string | null;
};

/** 总功率历史里的一个采样点 */
export type ChargerSample = {
  /** 毫秒时间戳 */
  t: number;
  /** 瓦 */
  w: number;
};

export type ChargerStatus = {
  /** BLE 会话是否活着 */
  connected: boolean;
  /** 整机输出功率（瓦） */
  totalPower: number;
  /** 额定最大功率，用来算功率条比例（Anker Prime 160W） */
  maxPower: number;
  ports: ChargerPort[];
  device: {
    serialNumber: string | null;
    firmwareVersion: string | null;
    /** 上报器给的型号，如 "A2687"。顶栏拿它拼 Anker 前缀。 */
    model: string | null;
  };
  /**
   * 充电头当前封面。上报器把 Anker 源 JPEG 原样直传到 R2 后带 iconObjectKey。
   * iconUrl 是读取时按当前部署的交付域现拼的，不入库。
   */
  cover: {
    name: string;
    iconHash: string | null;
    iconObjectKey: string | null;
    iconUrl: string | null;
  } | null;
  /** 遥测采集时刻，毫秒时间戳 */
  updatedAt: number | null;
};

/** 状态 + 服务端累积的历史，给前端画曲线用 */
export type ChargerPayload = ChargerStatus & {
  history: ChargerSample[];
  /**
   * history 里只有 `?since=` 之后新增的采样点，要接到客户端已有序列后面。
   * false 表示这是完整快照，直接替换 —— 首次请求，或客户端落后太多、
   * 中间那段已被服务端裁掉时都是这种。
   */
  historyPartial: boolean;
  /** 源站最近一次收到充电头模块或给它续上的心跳 */
  pushedAt: number;
  /** 这份数据自己的过期窗口；默认 90 秒，服务端可按上报间隔加长 */
  staleAfterMs: number;
} & ReporterPresence;

/**
 * 用量采集来源键，如 "claude" / "codex" / "cursor"。
 *
 * 信封不写死名单：上报器发几个 agent 就收几个，站点按 id 决定展示形态。
 */
export type VibeCodingAgentId = string;

export type VibeCodingDay = {
  /** 按站点统计时区 Asia/Shanghai 生成的 YYYY-MM-DD */
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  /** 按公开 API 价格估算，不是订阅账单 */
  apiEquivalentCostUSD: number;
};

/** 每个来源最近一次成功取得的用量及本轮同步状态；错误不会清空已保存历史。 */
export type VibeCodingUsageStatus = {
  state: "ok" | "error" | "unavailable";
  /** 最近成功采集时刻，尚未成功过为 null；失败时保留旧时刻。 */
  collectedAt: string | null;
  error: string | null;
  /** 已保存历史实际覆盖的首尾日期，YYYY-MM-DD；未知为 null。 */
  coverageStart: string | null;
  coverageEnd: string | null;
  precision: "measured" | "estimated" | "mixed";
  /** false 表示 API 等值费用只包含能估价的部分，不能当完整费用。 */
  costComplete: boolean;
};

/** 订阅套餐等级。tier 是上游原始枚举值，label 是给人看的展示名。 */
export type VibeCodingPlan = {
  /** 如 "prolite" / "max"，用来加 title 提示，页面主体不直接显示 */
  tier: string;
  /** 如 "Pro Lite" / "Max 5x" */
  label: string;
};

/**
 * 一个限额桶在一个时间窗口内的用量。
 *
 * 刻意做成数组而不是 `fiveHour` / `weekly` 这种固定字段：窗口的个数和时长是
 * 上游随时会调的（OpenAI 眼下就临时撤掉了 5 小时窗口，以后可能加回来），
 * 写死字段名的话每次变动都要改契约、改渲染、还得处理旧数据。
 */
export type VibeCodingLimit = {
  /** 桶 + 窗口的稳定标识，如 "codex.primary"，只用来当 React key */
  key: string;
  /** 子额度桶名如 "GPT-5.3-Codex-Spark"；主额度桶没有名字，为 null */
  label: string | null;
  /**
   * 粗分组，如 "session" / "weekly"。上游没给时为 null；展示层不得
   * 由分组反推窗口时长。
   */
  group: string | null;
  /** 窗口时长，展示用的「5 小时 / 7 天」由它现算；上游没给就是 null */
  windowMinutes: number | null;
  /** 0–100 */
  usedPercent: number;
  /** Unix 秒（不是毫秒），上游没给就是 null */
  resetsAt: number | null;
};

export type VibeCodingAgent = {
  id: VibeCodingAgentId;
  /** 上报器给的展示名，如 "Claude Code" / "Cursor" */
  label: string;
  /**
   * 品牌图标键，如 "cursor" / "grok"。和 id 不是一回事：id 是用量
   * 的来源名，这个是牌子。站点认不出来的键退回首字母，不是整行不渲染。
   *
   * 全量面板不用它（Claude / Codex 各有自己的活动灯），只给按需取用的
   * 那几行限额条当标记。
   */
  icon: string;
  models: string[];
  /** 最近使用的会话模型；会话数据缺失时回退到最近一个有用量日的主力模型。 */
  currentModel: string | null;
  /** 最近一次 session 活动；不含 session ID 或项目路径。 */
  lastActivityAt: string | null;
  /**
   * 上报器按最近五分钟是否有 session 活动计算。
   *
   * 是个电平，不是会自己过期的时间戳 —— 采集侧一停就冻在最后一次推送的值上，
   * 站点这边没有任何东西会去翻它。所以展示前必须和「这句话现在还算不算数」
   * 取与，见 vibecoding-card 的 activityUnknown。
   */
  active: boolean;
  /** 整份历史里 token 占比最大的模型。 */
  topModel: string | null;
  /** null 表示未取得用量，和已成功采集的零用量不同。 */
  today: VibeCodingDay | null;
  usageStatus: VibeCodingUsageStatus;
  /**
   * 下面四个字段来自另一条路：`/api/ingest/agents`，喂它的是 NAS 上的容器上报器
   * （`reporters/agent-limits-reporter`），不再随 Mac 的用量信封走。站点按 id
   * 把它们贴到对应来源行上；只有限额的来源也展示，用量为 null。
   *
   * 套餐取不到、或这个 agent 从没上报过限额时是 null —— 不渲染，不占位
   */
  plan: VibeCodingPlan | null;
  /** 没登录、凭据失效、从没上报过都会是空数组，UI 要能整块不渲染 */
  limits: VibeCodingLimit[];
  /**
   * 限额取失败的原因。空 limits 有两种含义 —— 这个 agent 没配（该整块不渲染），
   * 或者配了但取不到（该渲染并说明取不到）。靠它区分，null 表示前者。
   */
  limitsError: string | null;
  /**
   * 站点收到这个 agent 限额的时刻（epoch 毫秒），从没收到过是 null。
   * 陈旧与否由浏览器拿它和 `VibeCodingPayload.limitsStaleAfterMs` 现算 ——
   * 首屏是 `'use cache'` 冻住的，服务端拼「N 分钟没更新」会冻错。
   */
  limitsAt: number | null;
};

export type VibeCodingTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Codex 的 reasoning 是 output 的子集，画堆叠条时要从普通 output 中扣掉 */
  reasoningTokens: number;
  totalTokens: number;
  apiEquivalentCostUSD: number;
  /** API 等值费用是否覆盖全部 token；false 时数值只包含已知价格的部分。 */
  costComplete: boolean;
  activeDays: number;
  /** 所有来源的历史 session 数合计；不包含 session ID。 */
  sessionCount: number;
};

/**
 * `vibeCodingNow` 推给浏览器的那一小份：此刻在不在用、用的是哪个模型。
 *
 * 整张卡只有这三个字段说的是「此刻」，也只有它们值得走 60 秒那一轮。别往
 * 这里加累计量 —— 累计的东西一律归 `vibeCodingUsage`，那是十几分钟才动一次
 * 的事，混进来等于拿推送当轮询用。会话总数就是这么挪走的。
 */
export type VibeCodingNowPayload = {
  agents: Array<{
    id: VibeCodingAgentId;
    currentModel: string | null;
    lastActivityAt: string | null;
    active: boolean;
  }>;
};

export type VibeCodingPayload = {
  /**
   * 同一形状的来源列表。上报器发几个就有几个；首页按 id 取用：
   * `claude` / `codex` 画全量面板，其余只取限额那一行。
   */
  agents: VibeCodingAgent[];
  /** 限额可独立展示，尚未收到用量摘要时为 null。 */
  totals: VibeCodingTotals | null;
  /** 所有来源合并后的历史累计 token 前三名。 */
  topModels: Array<{ model: string; tokens: number }>;
  /** 摘要生成时间；来源成功时间分别记录在 usageStatus，尚无摘要时为 null。 */
  collectedAt: string | null;
  source: "local" | "push";
  /** 源站收到用量摘要的时刻；尚未收到时为 null。来源新鲜度看各自 usageStatus。 */
  pushedAt: number | null;
  /**
   * 限额那条路的陈旧窗口。容器上报器每轮必发（那一封就是心跳），窗口锚最慢档
   * 加缓存余量，服务端按 `AGENT_LIMITS_STALE_MS` 算好盖在这里，浏览器拿它和
   * 各行的 `limitsAt` 比。
   */
  limitsStaleAfterMs: number;
} & ReporterPresence;

/**
 * 过去 53 周的日合计 token。
 *
 * `days[i]` 是 origin 起第 i 天的合计。档位和文案浏览器现算，不进信封。
 * `mix` 是每天前五模型的稀疏编码，下标指 `models`。
 *
 * 每次刷新完整窗口，云端补回的旧日和模型拆分也会一起更新。
 */
export type VibeCodingYearPayload = {
  /** 53 周窗口的第一个周日，YYYY-MM-DD */
  origin: string;
  days: number[];
  /** 这一年里出现在每日前五里的模型名，mix 里的下标指这里。 */
  models: string[];
  /**
   * 稀疏的每日前五。一行是 `[offset, idx, tokens, idx, tokens, …]`，
   * offset 是 origin 起第几天，idx 是 models[] 下标。空日子不出现。
   */
  mix: number[][];
  pushedAt: number;
  /**
   * 源站在取数出口按自己的钟算的「今天是哪一天」（站点时区，YYYY-MM-DD）。
   * 热力图拿它切掉窗尾那截未来格子。
   *
   * **这件事整个由源站算**，理由同 `ActivityPayload.currentAtSource`：浏览器
   * 手上没有一个会走的钟。也不能用窗口自己的 `pushedAt` 顶替 —— 那是「上报器最后
   * 一次推送」，Mac 停一天，今天那格就跟着少一格，而隔壁 GitHub 那张图照常画到
   * 今天，两张图当场错开一列。
   *
   * 落进 SQLite 的那份没有它（`StoredVibeCodingYear`）：它是「现在几点」的函数，
   * 只能在取数出口现盖，见 lib/vibecoding-year 的 withYearFreshness。
   */
  todayAtSource: string;
};

/** 落库的那份：上报器给的窗口 + 源站盖的到达时刻，不含取数出口现算的那个今天。 */
export type StoredVibeCodingYear = Omit<VibeCodingYearPayload, "todayAtSource">;

/** 贡献热力图的一天。label 跟资料页 hover 同一句，浏览器现算，不进信封 */
export type GithubChartDay = {
  date: string;
  weekday: number;
  count: number;
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
};

/**
 * 过去约 53 周的日贡献。形状对齐年度 token：原点 + 日序列，date / weekday /
 * label 浏览器现算。`scores` 是 GitHub 自己的四分位，不能在这边重算。
 */
export type GithubChartPayload = {
  origin: string;
  counts: number[];
  scores: Array<0 | 1 | 2 | 3 | 4>;
  /**
   * counts / scores 只覆盖 `from` 起的窗尾。缺省或 false 是整份窗口。
   */
  countsPartial?: boolean;
  /** countsPartial 时这段尾巴的第一天 */
  from?: string;
};

/**
 * 所有 /api/status/* 的统一信封。
 *
 * 刻意不带时间戳。从前每个响应都盖一个 fetchedAt，结果是**任何两次响应在字节
 * 层面都不同** —— 而 SWR 靠深比较决定要不要更新缓存，于是数据一个字节没变，
 * 每轮轮询也会让所有卡片重渲染一遍（充电头那条 400 点曲线、最近在听那个带布局
 * 动画的列表，全都白跑）。
 *
 * 而且全站没有任何组件读它。真要知道服务端什么时候算的，看响应头 X-Fetched-At。
 */
export type StatusResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/** 上报被拒。不带 data，且与 T 无关 —— 各 ingest 端点共用同一种失败形状 */
export type IngestFailure = { ok: false; error: string };

/**
 * 所有 /api/ingest/* 的统一信封。
 *
 * 和 StatusResponse 分开是因为语义不同：status 那边 ok:false 也返回 200
 * （降级态给页面看），ingest 这边失败就是失败，状态码得让上报器能据此决定
 * 重不重试。
 */
export type IngestResponse<T = null> = { ok: true; data: T } | IngestFailure;

/**
 * 充电宝的一个端口。
 *
 * 和充电头的 `ChargerPort` 形状接近但不一样：C1/C2 是**双向**的，所以多一个
 * `direction`；固件不上报插在上面的设备是什么（充电头会），所以没有 `device`。
 */
export type PowerBankPort = {
  /** C1 / C2 / A / B（B 是底座进电口） */
  id: string;
  /** 该口是否有功率在流。空闲口的读数是过期的，一律置 null */
  active: boolean;
  /** "in" 取电 / "out" 供电 / null 空闲 */
  direction: "in" | "out" | null;
  /** 线插着，不管有没有协商上供电 */
  attached: boolean;
  power: number | null;
  voltage: number | null;
  current: number | null;
};

export type PowerBankStatus = {
  connected: boolean;
  /** 电量百分比，固件给到两位小数 */
  battery: number | null;
  /** 正在进电。放电和待机都是 false */
  charging: boolean;
  /** 充满还需多少分钟。只在充电时有意义，其余为 null */
  timeToFullMinutes: number | null;
  /** 机身过热、拒绝充电。插着线也不进电，所以要单独暴露 */
  thermalLimited: boolean;
  /**
   * 电池健康度，整数百分比（剩余容量 / 出厂容量）。
   *
   * 上报器只在每次连上充电宝时收到一次，之后整个会话都不会再变，所以它不参与
   * 「有没有变化」的判断，断开期间也保留上一次的值。
   */
  batteryHealth: number | null;
  inputPower: number;
  outputPower: number;
  /** 两个温度传感器，摄氏度 */
  temperatures: number[];
  ports: PowerBankPort[];
  device: {
    serialNumber: string | null;
    firmwareVersion: string | null;
    /** 上报器给的型号，如 "A110G"。顶栏拿它拼 Anker 前缀。 */
    model: string | null;
  };
  updatedAt: number | null;
};

/**
 * 充电宝不存历史。
 *
 * 卡片上没有曲线 —— 电量的变化尺度以小时计，一条几乎水平的线不如把空间让给
 * 电量条和收放电数字。既然没人消费，采样、裁剪、增量游标那一整套就都不该存在。
 */
export type PowerBankPayload = PowerBankStatus & {
  /** 源站最近一次收到充电宝模块的时刻 */
  pushedAt: number;
  /** 这份数据自己的过期窗口；默认 90 秒，服务端可按上报间隔加长 */
  staleAfterMs: number;
} & ReporterPresence;

/**
 * Apple Watch 的活动圆环：活动 / 锻炼 / 站立，一环两个数 —— 已完成和目标。
 *
 * **目标值跟着上报走，不在站点这侧写死。** 它只有原生 App 读得到
 * （`HKActivitySummary`），而且是人随时会调的；写死在站点里的话，改一次目标
 * 就要发一次版，还得两份部署一起改。
 *
 * 单位进字段名（AGENTS.md 第 4 条）：三环在 Apple 那边分别按千卡、分钟、小时
 * 计，三种单位摆在一起时，光看 `move` / `moveGoal` 认不出该配哪个。
 */
export type ActivityRings = {
  /** 活动：当天已消耗的活动能量，千卡 */
  moveKcal: number;
  moveGoalKcal: number;
  /** 锻炼：当天累计的锻炼分钟数 */
  exerciseMinutes: number;
  exerciseGoalMinutes: number;
  /** 站立：当天有站起来动过的小时数 */
  standHours: number;
  standGoalHours: number;
};

/**
 * 一天的健身记录。和 `DesktopActivity` 没有关系 —— 那个是 Mac 的前台应用，
 * 这里的「活动」是 Apple 的健身记录（Activity / 活动圆环）。
 *
 * `date` 是**手表本地的那一天**，站点绝不自己算：圆环在手表所在时区的午夜归零，
 * 而源站的钟在美国、访客的钟在任何地方，两边都答不出「手表那边今天是几号」。
 * `secondsFromGMT` 和 Mac 时区模块同名同单位（AGENTS.md 第 4 条），卡片拿它现算
 * 「手表那边现在是不是还是这一天」—— 跨过午夜之后，这份满环说的就是昨天了。
 */
export type ActivityStatus = ActivityRings & {
  /** 手表本地日，YYYY-MM-DD */
  date: string;
  /** 观测时手表所在时区的 UTC 偏移，秒 */
  secondsFromGMT: number;
  /** 当天步数。上报器没开这项权限时为 null，卡片整格不渲染 */
  steps: number | null;
  /** 当天步行 + 跑步距离，米 */
  distanceMeters: number | null;
  /** 当天爬楼层数 */
  flightsClimbed: number | null;
};

/**
 * 活动圆环对外那一份。
 *
 * **没有 `ReporterPresence`。** 这不是 Mac 上报器那种「一直在线才算数」的数据源：
 * 手机整夜不动就没有新样本可推，那时圆环冻在最后一次推送上是正确的，不是掉线。
 * 真正会让这份数据变错的只有一件事 —— 手表那边跨过了午夜，圆环已经归零而站点
 * 还举着昨天那份，所以只盖 `currentAtSource` 这一个判定。
 */
export type ActivityPayload = ActivityStatus & {
  /** 源站收到这份的时刻。卡片拿它写「几分钟前」，不用来判过期 */
  pushedAt: number;
  /**
   * 源站在取数出口按自己的钟算的那一次「手表那边现在还是不是 `date` 这一天」。
   *
   * **这件事整个由源站算，浏览器不自己算一遍。** 和 `offlineAtSource` 那种
   * 「首帧用它、之后浏览器接着算」的字段不一样：浏览器手上没有一个会走的钟
   * （`useMountedAt` 是挂载那一刻的定格），拿它比日期的话，开着不动的标签页永远
   * 停在挂载那一天，跨夜之后新到的**今天**那份反而会被判成「昨天的记录」。
   *
   * 它是数据字段，服务端预渲染和 hydrate 读到的是同一个值，不会水合不一致。
   * 端点每次请求现算，所以卡片那 5 分钟一轮的轮询就是它的刷新节奏；冻住的首屏
   * 那份最多旧 10 分钟（见 lib/status-cache），挂载时的那次回源会纠正它。
   */
  currentAtSource: boolean;
};

/**
 * 落地节点此刻的读数。单位进字段名（AGENTS.md 第 4 条）：字节、秒、百分比
 * 三种摆在一起，光看 `memory` / `uptime` 认不出该配哪个。
 *
 * `id` 是 SSH 配置里的那一个（`misaka-jp`），`hostname` 是机器自己报的
 * `uname`。两份都留：卡片上认的是人起的名字，出了问题对照机器要用另一份。
 */
export type ServerStatus = {
  id: string;
  hostname: string;
  /** 默认路由网卡上的公网地址。卡片上的那串 IP */
  publicIp: string;
  /** 查 IP 得到的国家，如「日本」。查不到为 null */
  country: string | null;
  /** 查 IP 得到的城市，如 Tokyo */
  city: string | null;
  isp: string | null;
  /** 自治系统号，没有 AS 前缀。查不到为 null */
  asn: number | null;
  asnOrg: string | null;
  os: string;
  kernel: string;
  cpuCores: number;
  /** 0–100，这一段采样窗口内的平均占用 */
  cpuUsagePercent: number;
  load1: number;
  load5: number;
  load15: number;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  memoryAvailableBytes: number;
  diskTotalBytes: number;
  diskUsedBytes: number;
  /** 默认路由那块网卡。和累计字节挨着，免得多网卡时分不清这份是谁的 */
  networkInterface: string;
  networkRxBytes: number;
  networkTxBytes: number;
  networkRxBytesPerSec: number;
  networkTxBytesPerSec: number;
  uptimeSeconds: number;
  /** 采集时刻，epoch 毫秒 */
  observedAt: number;
};

/**
 * 落地节点对外那一份。
 *
 * **没有 `ReporterPresence`。** 那套是 Mac 上报器的存活：亲口离线、心跳窗口、
 * 全站四张卡共用一个答案。这台节点的上报器挂了只影响这一张卡，用自己的
 * `staleAfterMs` 判定就够了，不该绑到 Mac 那份存活上。
 */
export type ServerPayload = ServerStatus & {
  /** 源站收到这份的时刻 */
  pushedAt: number;
  /** 这份数据自己的过期窗口；默认 90 秒，服务端可按上报间隔加长 */
  staleAfterMs: number;
  /**
   * 源站在取数出口按自己的钟算的那一次「这会儿算不算断流」。
   *
   * 为首帧准备 —— 那一帧浏览器还没有钟（useMountedAt 为 0），拿 pushedAt
   * 什么也判不出来。它是数据字段，服务端预渲染和 hydrate 读到的是同一个值。
   */
  staleAtSource: boolean;
};
