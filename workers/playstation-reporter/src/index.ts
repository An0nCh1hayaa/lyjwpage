import { AuthSession } from "./auth";
import {
  countUrl,
  hiddenTitleIds,
  isDryRun,
  playedGamesLimit,
  titleIdsHidden,
  withoutHiddenTitleIds,
  type Env,
} from "./env";
import {
  fetchPlayedGames,
  fetchPresence,
  fetchPurchasedLibrary,
  mergePlayedGames,
  overlayLibrary,
  withUnplayedPreorders,
  type LibraryTitle,
  type PlayedGamesReport,
  type PresenceReport,
} from "./psn";
import { deliver } from "./site";
import {
  LIBRARY_CACHE_KEY,
  LIBRARY_TTL_MS,
  PLAYED_GAMES_CACHE_KEY,
  PLAYED_GAMES_FINGERPRINT_KEY,
  PLAYED_GAMES_IDLE_TTL_MS,
  PLAYED_GAMES_PLAYING_TTL_MS,
  TICK_META_KEY,
  TROPHIES_FINGERPRINT_KEY,
  TROPHY_CATALOG_KEY,
  TROPHY_SYNC_KEY,
  asLibraryCache,
  asPlayedGamesCache,
  asTrophyCatalog,
  profileIdentityFresh,
  readFullTickStartedAt,
  writeFullTickStartedAt,
  writeLibraryCache,
  writePlayedGamesCache,
  writeTrophyCatalog,
  type TickMeta,
  type TrophyCatalog,
} from "./state";
import {
  buildTrophiesReport,
  dirtyIndexRows,
  fetchProfileIdentity,
  fetchTrophySummary,
  fetchTrophyTitleSlice,
  fetchTrophyTitles,
  indexFingerprint,
  mapPlayByTrophy,
  mergePlayByTrophy,
  mergeTrophyTitles,
  playByTrophyFromTitles,
  playLinkGames,
  profileFromSummary,
  snapshotIndex,
  trophySummarySignature,
  type TrophiesReport,
  type TrophySummary,
} from "./trophies";

function playedGamesFingerprint(report: PlayedGamesReport): string {
  return JSON.stringify(report.items);
}

function recentPlayed(report: PlayedGamesReport, env: Env): PlayedGamesReport {
  const limit = playedGamesLimit(env);
  if (report.items.length <= limit) return report;
  return { ...report, items: report.items.slice(0, limit) };
}

function explain(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trophiesFingerprintOf(hidden: Set<string>, body: string): string {
  return JSON.stringify({
    hidden: [...hidden].sort(),
    drop: "after-link",
    body,
  });
}

function filterHidden(report: TrophiesReport, hidden: Set<string>): TrophiesReport {
  if (!hidden.size) return report;
  return {
    ...report,
    titles: report.titles.filter((title) => !titleIdsHidden(title.titleIds, hidden)),
  };
}

function catalogProfile(
  profile: TrophiesReport["profile"],
  fetchedAt: number,
): TrophyCatalog["profile"] {
  return { ...profile, fetchedAt };
}

/**
 * 奖杯目录没变，但资料 TTL 过了：不翻目录、不爬明细，只重拉
 * onlineId / 头像 / Plus，整份交上去，好让站点上的头像真的会每天刷新。
 */
async function refreshStoredProfile(
  env: Env,
  auth: AuthSession,
  hidden: Set<string>,
  last: TrophyCatalog,
  summary: TrophySummary,
  nextFingerprint: string,
  summarySignature: string,
): Promise<{
  trophies: TrophiesReport;
  trophiesChanged: boolean;
  nextFingerprint: string;
  catalog: TrophyCatalog;
}> {
  const now = Date.now();
  const fetched: TrophiesReport = {
    observedAt: now,
    profile: profileFromSummary(await fetchProfileIdentity(env, auth, summary), summary),
    titles: last.titles,
  };
  console.log(JSON.stringify({ event: "playstation-trophy-sync", action: "profile" }));
  return {
    trophies: filterHidden(fetched, hidden),
    trophiesChanged: true,
    nextFingerprint,
    catalog: {
      ...last,
      fingerprint: nextFingerprint,
      summarySignature,
      profile: catalogProfile(fetched.profile, now),
    },
  };
}

/**
 * 奖杯只在整份齐了才交给 deliver。没变的标题从上次交付的目录合并，不重打 PSN。
 * 个人资料（onlineId / 头像 / Plus）按 PROFILE_TTL_MS 单独判断，不跟目录绑死。
 */
async function syncTrophies(
  env: Env,
  auth: AuthSession,
  hidden: Set<string>,
  overlaid: PlayedGamesReport,
  oldTrophiesFingerprint: string | null,
  last: TrophyCatalog | null,
  summary: TrophySummary,
): Promise<{
  trophies: TrophiesReport | null;
  trophiesChanged: boolean;
  nextFingerprint: string;
  catalog?: TrophyCatalog;
}> {
  const summarySignature = trophySummarySignature(hidden, summary);
  const profileFresh = profileIdentityFresh(last?.profile);

  if (last && last.summarySignature === summarySignature && last.fingerprint === oldTrophiesFingerprint) {
    if (profileFresh) {
      console.log(JSON.stringify({ event: "playstation-trophy-sync", action: "skip" }));
      return { trophies: null, trophiesChanged: false, nextFingerprint: last.fingerprint };
    }
    // quiet 也要过期重拉：头像 / Plus 不进奖杯指纹，不重拉就永远停在旧的。
    return refreshStoredProfile(env, auth, hidden, last, summary, last.fingerprint, summarySignature);
  }

  const titles = await fetchTrophyTitles(env, auth);
  const nextFingerprint = trophiesFingerprintOf(hidden, indexFingerprint(titles, summary));
  // 目录必须和指纹同一代：KV 先写 fp:trophies 再写 trophies:last，错代时
  // last.titles 是旧的，交上去会把站点刚收下的解锁整份盖掉。
  if (
    nextFingerprint === oldTrophiesFingerprint &&
    last &&
    last.fingerprint === oldTrophiesFingerprint
  ) {
    if (profileFresh) {
      return { trophies: null, trophiesChanged: false, nextFingerprint };
    }
    return refreshStoredProfile(env, auth, hidden, last, summary, nextFingerprint, summarySignature);
  }

  const titleIds = titles.map((title) => title.npCommunicationId);
  const dirty = last ? dirtyIndexRows(last.index, titles) : titles;
  console.log(
    JSON.stringify({
      event: "playstation-trophy-sync",
      action: "plan",
      dirty: dirty.length,
      total: titleIds.length,
      reused: titleIds.length - dirty.length,
    }),
  );

  const previousById = new Map((last?.titles ?? []).map((title) => [title.npCommunicationId, title]));
  const crawled = dirty.length ? await fetchTrophyTitleSlice(env, auth, dirty, previousById) : [];
  const merged = mergeTrophyTitles(last?.titles ?? [], crawled, titleIds);
  if (merged.length !== titleIds.length) {
    const missing = titleIds.filter((id) => !merged.some((title) => title.npCommunicationId === id));
    throw new Error(`奖杯目录缺 ${missing[0] ?? "未知标题"}`);
  }

  let byTrophy = playByTrophyFromTitles(merged, overlaid.items);
  if (merged.some((title) => title.titleIds.length === 0)) {
    const games = playLinkGames(overlaid);
    const mappedIds = new Set(merged.flatMap((title) => title.titleIds));
    const unmapped = games.filter((game) => !mappedIds.has(game.titleId));
    const toLink = unmapped.length ? unmapped : games;
    if (toLink.length) {
      byTrophy = mergePlayByTrophy(await mapPlayByTrophy(env, auth, toLink), byTrophy);
      console.log(
        JSON.stringify({
          event: "playstation-trophy-sync",
          action: "link",
          games: toLink.length,
          of: games.length,
        }),
      );
    }
  }

  // 资料还新鲜就别在 dirty 重爬时再打一遍；等级 / 总杯数走下面 summary 覆盖。
  const fetched = await buildTrophiesReport(
    env,
    auth,
    summary,
    merged,
    byTrophy,
    profileFresh ? last?.profile : null,
  );
  return {
    trophies: filterHidden(fetched, hidden),
    trophiesChanged: true,
    nextFingerprint,
    catalog: {
      fingerprint: nextFingerprint,
      summarySignature,
      index: snapshotIndex(titles),
      titles: fetched.titles,
      profile: catalogProfile(
        fetched.profile,
        profileFresh && last?.profile.fetchedAt != null ? last.profile.fetchedAt : Date.now(),
      ),
    },
  };
}

type TickResult = {
  meta: TickMeta;
  presence: PresenceReport;
  playedGames: PlayedGamesReport;
  trophies: TrophiesReport | null;
};

/**
 * 有人**正看着**站点时的完整 tick 间隔。cron 每分钟一响，卡 60 秒整的话早响半秒
 * 的那一轮会被门挡掉、实际退化成两分钟一轮，所以留 5 秒余量。
 */
const LIVE_TICK_INTERVAL_MS = 55_000;
/**
 * 页面**开着但都在后台**时的 tick 间隔（切走的标签页、锁了屏的手机）。同样留
 * 5 秒取整余量：2 分钟一轮。
 *
 * 这一档是为「切走了但还会切回来」留的 —— 那些页面在 `online` 那个数里算 0
 * （站点侧 use-online-count 在不可见时把连接整条关掉），但事件推送那条不关，
 * 它们还在 `connections` 里。
 */
const OPEN_TICK_INTERVAL_MS = 115_000;
/**
 * 一个页面都没开时的完整 tick 间隔。同样留取整余量：每分钟的 cron 把它凑成
 * 15 分钟整一轮，和从前那根十五分钟的 cron 一模一样，闲时对 PSN 的流量不变。
 *
 * 站点 `src/lib/freshness.ts` 的 `PLAYSTATION_STALE_MS`（50 分钟 = 三轮 + 余量）
 * 锚的就是这个数。要动它，先去改那边。
 */
const IDLE_TICK_INTERVAL_MS = 14.5 * 60_000;
/** 人头数读不回来不该拖着 tick 等，超时就当没人。 */
const COUNT_TIMEOUT_MS = 2_500;

type HeadCounts = { online: number; open: number };

function nonNegativeCount(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

/**
 * 问 API Worker 要两个人头数（一次请求，`online` 可见、`connections` 开着）。
 * 超时、非 200、形状不对，一律当 0。
 *
 * 这个兜底方向是单向的：读不到只会让节奏往慢里退，永远不会因为故障变快 ——
 * 认错方向的代价是每分钟撞一次 PSN。
 */
async function headCounts(url: string): Promise<HeadCounts> {
  if (!url) return { online: 0, open: 0 };
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(COUNT_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`返回 ${response.status}`);
    const body = (await response.json()) as Record<string, unknown> | null;
    return { online: nonNegativeCount(body?.online), open: nonNegativeCount(body?.connections) };
  } catch (error) {
    console.warn(JSON.stringify({ event: "playstation-head-count", error: explain(error) }));
    return { online: 0, open: 0 };
  }
}

/**
 * 上一轮完整 tick 的开始时刻，isolate 本地这一份。
 *
 * KV 的读有最长 60 秒的边缘缓存，而门的阈值正好在这个量级上：相邻两响里后一响
 * 可能还拿着写入之前的旧值，把同一轮放行两次。cron 每分钟一响，相邻两响多半落在
 * 同一个 isolate 上，所以和 KV 那份取较晚的一枚就能挡掉这种重复。两份记的都是
 * 真实发生过的开始时刻，取晚的不会误挡；isolate 冷起时它是 0，退回纯 KV 判断。
 */
let lastFullTickAt = 0;

type Gate = {
  run: boolean;
  sinceMs: number;
  /** 这一响真去问了的那些数；没问到那一步的留 null */
  online: number | null;
  open: number | null;
};

/**
 * cron 每分钟一响，这道门决定这一响要不要真跑一轮。
 *
 * 三档，由两个人头数分出来：有页面**可见**就 55 秒一轮，只是**开着**（后台标签
 * 页、锁了屏的手机）就 115 秒，一个都没有就 15 分钟。
 *
 * 门里只有两个读操作（KV 一枚时间戳 + 一次两个人头数），都排在任何贵操作之前：被挡
 * 下的那一轮完全不碰 PSN、不碰站点。而且是层层短路的 —— 攒够闲档就不问人数，
 * 没攒够快档阈值也不问。间隔算的是**上一轮开始**的时刻而不是成功的时刻 —— 否则
 * PSN 持续故障时，重试会从十五分钟一次恶化成每分钟一次。
 */
async function shouldTick(env: Env): Promise<Gate> {
  const lastAt = Math.max(await readFullTickStartedAt(env.STATE), lastFullTickAt);
  const sinceMs = lastAt > 0 ? Date.now() - lastAt : Number.POSITIVE_INFINITY;
  // 攒够闲档就必跑，不必再问人数：闲时节奏不该依赖 API Worker 可不可达
  if (sinceMs >= IDLE_TICK_INTERVAL_MS) return { run: true, sinceMs, online: null, open: null };
  if (sinceMs < LIVE_TICK_INTERVAL_MS) return { run: false, sinceMs, online: null, open: null };

  const { online, open } = await headCounts(countUrl(env));
  if (online > 0) return { run: true, sinceMs, online, open };
  if (sinceMs < OPEN_TICK_INTERVAL_MS) return { run: false, sinceMs, online, open };
  return { run: open > 0, sinceMs, online, open };
}

type Inflight = { promise: Promise<TickResult>; forced: boolean };
let inflight: Inflight | null = null;

/**
 * 同一 isolate 里只跑一轮。本地 8788 会被 Chrome 探 /json/version 再连打 GET /，
 * 这道去重就是把那一串探测压成一轮的东西。
 *
 * 强制那一轮不能拿正在跑的普通轮次充数 —— 那轮走的是缓存，正是它要绕开的。
 * 撞上了就排在后面：等普通那轮结束（成败都行），再整份跑一遍。排队的那轮从
 * 此就是锁的持有者：每轮记一个条目，收尾时**只有条目还是自己**才把锁放掉，
 * 前一轮的收尾不会把后一轮的锁顺手清了。
 */
function tickOnce(env: Env, force = false): Promise<TickResult> {
  const current = inflight;
  if (current && (!force || current.forced)) return current.promise;

  const promise = current
    ? current.promise.catch(() => undefined).then(() => tick(env, true))
    : tick(env, force);
  const entry: Inflight = { promise, forced: force };
  inflight = entry;
  const release = () => {
    if (inflight === entry) inflight = null;
  };
  // 两个分支都接上，别让 finally 派生出一条没人接的拒绝
  promise.then(release, release);
  return promise;
}

/**
 * `force` 是「把这一轮当成 KV 空着跑」：缓存、指纹、目录一律当没有，于是下面每条
 * 分支都走冷启动那一侧 —— 游玩列表整份翻、购买库重拉、奖杯目录每款都爬、资料
 * 重问、两封信不比指纹都交付。不另开一套分支，冷启动路径本来就是全量路径。
 */
async function tick(env: Env, force = false): Promise<TickResult> {
  const startedAt = Date.now();
  // 同步落一份给门，别等下面那个 await —— 它要挡的就是「KV 还没读到新值」那一响
  lastFullTickAt = startedAt;
  let playedGamesChanged = false;
  let trophiesChanged = false;
  let trophies: TrophiesReport | null = null;

  try {
    const [
      storedPlayedGamesFingerprint,
      storedTrophiesFingerprint,
      storedCatalog,
      storedPlayedGames,
      storedLibrary,
    ] = await Promise.all([
      env.STATE.get(PLAYED_GAMES_FINGERPRINT_KEY),
      env.STATE.get(TROPHIES_FINGERPRINT_KEY),
      env.STATE.get(TROPHY_CATALOG_KEY, "json"),
      env.STATE.get(PLAYED_GAMES_CACHE_KEY, "json"),
      env.STATE.get(LIBRARY_CACHE_KEY, "json"),
      env.STATE.delete(TROPHY_SYNC_KEY),
      // 门读的就是这一枚。写在打 PSN 之前，所以它记的是「这轮开始过」而不是
      // 「这轮成功过」—— 上游持续故障时的重试节奏才跟基线一致。
      writeFullTickStartedAt(env.STATE, startedAt),
    ]);
    const oldPlayedGamesFingerprint = force ? null : storedPlayedGamesFingerprint;
    const oldTrophiesFingerprint = force ? null : storedTrophiesFingerprint;
    const lastCatalog = force ? null : asTrophyCatalog(storedCatalog);
    const playedCache = force ? null : asPlayedGamesCache(storedPlayedGames);
    const libraryCache = force ? null : asLibraryCache(storedLibrary);

    const hidden = hiddenTitleIds(env);
    const auth = new AuthSession(env);
    const [rawPresence, summary] = await Promise.all([
      fetchPresence(env, auth),
      fetchTrophySummary(env, auth),
    ]);
    const presence =
      rawPresence.playing && hidden.has(rawPresence.playing.titleId)
        ? { ...rawPresence, playing: null }
        : rawPresence;

    const playing = presence.playing != null;
    // 在玩时的 TTL 对着闲时那档完整 tick 节奏：从前「在玩每轮刷」那会儿一轮正好
    // 15 分钟，这里维持同一个节奏，快节奏下也不会每分钟去翻一遍分页列表。
    const playedTtlMs = playing ? PLAYED_GAMES_PLAYING_TTL_MS : PLAYED_GAMES_IDLE_TTL_MS;
    const playedFresh =
      playedCache != null && Date.now() - playedCache.fetchedAt < playedTtlMs;
    const libraryFresh =
      libraryCache != null && Date.now() - libraryCache.fetchedAt < LIBRARY_TTL_MS;
    const trophiesQuiet =
      lastCatalog != null &&
      lastCatalog.summarySignature === trophySummarySignature(hidden, summary) &&
      lastCatalog.fingerprint === oldTrophiesFingerprint;

    const refreshPlayed = !playedFresh;
    const refreshLibrary = !libraryFresh;
    const playedCap = trophiesQuiet ? playedGamesLimit(env) : Number.POSITIVE_INFINITY;

    let playedGames: PlayedGamesReport = playedCache?.report ?? { observedAt: Date.now(), items: [] };
    let library: LibraryTitle[] = libraryCache?.items ?? [];

    const extras: Promise<void>[] = [];
    if (refreshPlayed) {
      extras.push(
        (async () => {
          const fetched = await fetchPlayedGames(env, auth, playedCap);
          playedGames =
            Number.isFinite(playedCap) && playedCache
              ? mergePlayedGames(playedCache.report, fetched)
              : fetched;
          await writePlayedGamesCache(env.STATE, { fetchedAt: Date.now(), report: playedGames });
          console.log(
            JSON.stringify({
              event: "playstation-played-games",
              cached: false,
              capped: Number.isFinite(playedCap),
              titles: playedGames.items.length,
            }),
          );
        })(),
      );
    } else {
      console.log(
        JSON.stringify({
          event: "playstation-played-games",
          cached: true,
          ageMs: playedCache ? Date.now() - playedCache.fetchedAt : 0,
          titles: playedGames.items.length,
        }),
      );
    }
    if (refreshLibrary) {
      extras.push(
        (async () => {
          try {
            library = await fetchPurchasedLibrary(env, auth);
            await writeLibraryCache(env.STATE, { fetchedAt: Date.now(), items: library });
            console.log(
              JSON.stringify({
                event: "playstation-library",
                titles: library.length,
                preorders: library.filter((item) => item.preOrder).length,
                plus: library.filter((item) => item.membership === "PS_PLUS").length,
              }),
            );
          } catch (error) {
            console.error(
              JSON.stringify({ event: "playstation-library", error: explain(error) }),
            );
            // 强制那一轮要的就是这份库：拿不到就整轮失败，别交一份没有预购的
            // 列表上去、再把指纹盖上 —— 那等于把预购从站点上抹掉。
            if (force) throw new Error(`购买库拉取失败：${explain(error)}`);
            if (!libraryCache) library = [];
          }
        })(),
      );
    } else {
      console.log(
        JSON.stringify({
          event: "playstation-library",
          cached: true,
          ageMs: libraryCache ? Date.now() - libraryCache.fetchedAt : 0,
          titles: library.length,
        }),
      );
    }
    if (extras.length) await Promise.all(extras);
    const overlaid = overlayLibrary(playedGames, library);
    const entitledPlayed = {
      ...overlaid,
      items: withoutHiddenTitleIds(overlaid.items, hidden),
    };
    const recentPlayedGames = withUnplayedPreorders(
      recentPlayed(entitledPlayed, env),
      entitledPlayed,
      withoutHiddenTitleIds(library, hidden),
    );
    const nextPlayedGamesFingerprint = playedGamesFingerprint(recentPlayedGames);
    playedGamesChanged = nextPlayedGamesFingerprint !== oldPlayedGamesFingerprint;

    // 两封信各交各的：一封被站点 400，不该把另一封的指纹也扣住不写。
    const failures: string[] = [];

    // presence 每轮必发：站点靠这枚 observedAt 判 worker 死活，内容没变它自己压掉广播。
    // 排在奖杯前面：心跳便宜且关键，奖杯那半失败不该挡住这一封。
    try {
      await deliver(env, {
        version: 1,
        presence,
        ...(playedGamesChanged ? { playedGames: recentPlayedGames } : {}),
      });
      if (playedGamesChanged) {
        await env.STATE.put(PLAYED_GAMES_FINGERPRINT_KEY, nextPlayedGamesFingerprint);
      }
    } catch (error) {
      failures.push(`presence 交付失败：${explain(error)}`);
      console.error(
        JSON.stringify({ event: "playstation-deliver", part: "presence", error: explain(error) }),
      );
    }

    try {
      const synced = await syncTrophies(
        env,
        auth,
        hidden,
        overlaid,
        oldTrophiesFingerprint,
        lastCatalog,
        summary,
      );
      trophies = synced.trophies;
      trophiesChanged = synced.trophiesChanged;
      if (trophiesChanged && trophies) {
        try {
          await deliver(env, { version: 1, trophies });
          await env.STATE.put(TROPHIES_FINGERPRINT_KEY, synced.nextFingerprint);
          if (synced.catalog) await writeTrophyCatalog(env.STATE, synced.catalog);
        } catch (error) {
          failures.push(`trophies 交付失败：${explain(error)}`);
          console.error(
            JSON.stringify({
              event: "playstation-deliver",
              part: "trophies",
              error: explain(error),
            }),
          );
        }
      }
    } catch (error) {
      console.error(
        JSON.stringify({ event: "playstation-trophies", error: explain(error) }),
      );
    }

    if (failures.length) throw new Error(failures.join("；"));

    const meta: TickMeta = {
      startedAt,
      completedAt: Date.now(),
      ok: true,
      playedGamesChanged,
      trophiesChanged,
      dryRun: isDryRun(env),
      forced: force,
    };
    await env.STATE.put(TICK_META_KEY, JSON.stringify(meta));
    console.log(JSON.stringify({ event: "playstation-tick", ...meta }));
    return { meta, presence, playedGames: recentPlayedGames, trophies };
  } catch (error) {
    const meta: TickMeta = {
      startedAt,
      completedAt: Date.now(),
      ok: false,
      playedGamesChanged,
      trophiesChanged,
      dryRun: isDryRun(env),
      forced: force,
      error: explain(error),
    };
    await env.STATE.put(TICK_META_KEY, JSON.stringify(meta));
    console.error(JSON.stringify({ event: "playstation-tick", ...meta }));
    throw error;
  }
}

export default {
  /**
   * cron 每分钟一响，真跑哪一响由 `shouldTick` 定：有人正看着 60 秒一轮，页面
   * 只是开着 2 分钟一轮，一个页面都没开 15 分钟一轮。被挡下的那一响什么都不做。
   */
  async scheduled(_controller, env) {
    const { run, sinceMs, online, open } = await shouldTick(env);
    console.log(
      JSON.stringify({
        event: "playstation-tick-gate",
        run,
        online,
        open,
        sinceMs: Number.isFinite(sinceMs) ? sinceMs : null,
      }),
    );
    if (!run) return;
    await tickOnce(env);
  },

  /**
   * 两个手动入口，都不走门，都会刷新那枚开始时刻（手动跑完之后下一轮定时的
   * 跟着往后顺延）。访问控制由前面的 Cloudflare Access 负责，token 永远不出现在
   * 响应里。
   *
   * - `GET /`：**全量刷新，忽略所有缓存**。游玩列表整份翻、购买库重拉、奖杯目录
   *   每款重爬、资料重问，两封信不比指纹都交付。贵：每款奖杯 4 次出网、每款游戏
   *   一次对齐，别把它接进任何监控或定时器。
   * - `GET /tick`：普通一轮，该走缓存走缓存、比指纹、变了才交付。
   *
   * 根路径跑全量有个已知的坑：本地 `wrangler dev` 时 Chrome / Cursor 会拿调试口探
   * `/json/version` 再连打 GET /。tickOnce 的去重把一串探测压成一轮，但那一轮仍是
   * 全量的 —— 本地别拿浏览器开根路径。
   */
  async fetch(request, env) {
    if (request.method !== "GET") {
      return Response.json({ ok: false, error: "Method Not Allowed" }, { status: 405 });
    }
    const path = new URL(request.url).pathname;
    if (path !== "/" && path !== "/tick") {
      return Response.json({ ok: false, error: "Not Found" }, { status: 404 });
    }
    try {
      const { meta, presence, playedGames, trophies } = await tickOnce(env, path === "/");
      return Response.json({
        ...meta,
        presence,
        playedGames,
        trophies: trophies
          ? {
              observedAt: trophies.observedAt,
              level: trophies.profile.level,
              earned: trophies.profile.earned,
              titleCount: trophies.titles.length,
            }
          : null,
      });
    } catch (error) {
      const meta = await env.STATE.get<TickMeta>(TICK_META_KEY, "json");
      return Response.json(
        { ok: false, error: explain(error), lastTick: meta },
        { status: 502 },
      );
    }
  },
} satisfies ExportedHandler<Env>;
