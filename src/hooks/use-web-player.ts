"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  applyRepeatMode,
  getMusicKit,
  MUSICKIT_TOKEN_ENDPOINT,
  PLAYBACK_STATE,
  type MediaItem,
  type MusicKitInstance,
} from "@/lib/musickit";
import type { ListeningItem } from "@/lib/types";
import {
  getCachedPlaylist,
  queueOptionsFor,
  resolveVisibleQueue,
  setCachedPlaylist,
} from "@/lib/web-player";

export type WebPlayerStatus =
  | "unavailable" // 没配 MUSICKIT_TOKEN_ENDPOINT，功能整体不可用
  | "idle" // 可用，还没碰过 MusicKit
  | "starting" // 正在加载 MusicKit / 取令牌 / 等授权弹窗 / 装队列
  | "ready" // 拿到已授权的实例，队列已经装进去
  | "error";

export type WebPlayer = {
  status: WebPlayerStatus;
  authorized: boolean;
  error: string | null;
  /** 装进播放器的那张专辑 / 歌单；null 表示没有 */
  item: ListeningItem | null;
  /** 弹窗开着 */
  open: boolean;
  /** 见 PLAYBACK_STATE */
  playbackState: number;
  nowPlaying: MediaItem | null;
  queue: MediaItem[];
  /** 已经开始放过（在播、暂停、缓冲都算）。页头缩略播放器按它显示；stop 后为 false */
  active: boolean;
  /** 配好的实例，弹窗自己订阅进度用；没拿到是 null */
  instance: MusicKitInstance | null;
  /** 点了某张专辑：装入、打开弹窗并把队列装进实例，不开播；换了一张会把正在放的停掉 */
  openWith: (item: ListeningItem) => void;
  /** 只打开 / 关闭弹窗，不动播放 */
  openDialog: () => void;
  closeDialog: () => void;
  /** 弹窗里的 Sign in：authorize；正在试听的话重装成完整曲目接着放 */
  signIn: () => void;
  /** 队列没装时装队列开播，装了就是续播。未授权时放的是 30 秒试听 */
  play: () => void;
  pause: () => void;
  toggle: () => void;
  next: () => void;
  previous: () => void;
  /** 毫秒 */
  seekTo: (ms: number) => Promise<void>;
  /** 切到队列里第 index 首 */
  playAt: (index: number) => void;
  /** 停止并清队列；item 保留（弹窗还能再点播放），active 变 false */
  stop: () => void;
  /** 停止并 unauthorize */
  logout: () => void;
};

/** 错误转换为文案 */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "未知错误";
}

/**
 * 复制自 use-listen-along.ts：拦截用户或代码快速切歌、暂停时触发的正常打断报错，
 * 避免 MusicKit 或浏览器将其作为未捕获异常抛出。
 */
function isPlayInterrupted(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    (error instanceof Error && error.name === "AbortError") ||
    message.includes("interrupted by a new load request") ||
    message.includes("interrupted by a call to pause") ||
    /operation was aborted/i.test(message)
  );
}

/** 包装播放异步调用，安全吸收打断错误 */
async function mkSafe(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (isPlayInterrupted(error)) return;
    throw error;
  }
}

/** 实例是否正在播放或缓冲中 */
function isPlaybackActive(inst: MusicKitInstance): boolean {
  const s = inst.playbackState;
  return (
    s === PLAYBACK_STATE.playing ||
    s === PLAYBACK_STATE.loading ||
    s === PLAYBACK_STATE.waiting ||
    s === PLAYBACK_STATE.seeking
  );
}

export function useWebPlayerState(): WebPlayer {
  const [status, setStatus] = useState<WebPlayerStatus>(
    MUSICKIT_TOKEN_ENDPOINT ? "idle" : "unavailable",
  );
  const [authorized, setAuthorized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [item, setItem] = useState<ListeningItem | null>(null);
  const [open, setOpen] = useState(false);
  const [playbackState, setPlaybackState] = useState<number>(PLAYBACK_STATE.none);
  const [nowPlaying, setNowPlaying] = useState<MediaItem | null>(null);
  const [queue, setQueue] = useState<MediaItem[]>([]);
  const [active, setActive] = useState(false);
  const [instance, setInstance] = useState<MusicKitInstance | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);

  const instanceRef = useRef<MusicKitInstance | null>(null);
  const itemRef = useRef<ListeningItem | null>(null);
  const activeRef = useRef(false);
  const openRef = useRef(false);
  /** 实例里此刻装着哪张专辑的队列。stop 会把队列清掉，那时归 null，下次要重装 */
  const loadedIdRef = useRef<string | null>(null);

  useEffect(() => {
    itemRef.current = item;
  }, [item]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  /**
   * 改播放的操作排成一条排他链，避免并发 play/pause/setQueue 导致 MusicKit 报错。
   */
  const opChain = useRef(Promise.resolve());
  const runExclusive = useCallback((fn: () => Promise<void>) => {
    const next = opChain.current.then(fn, fn);
    opChain.current = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }, []);

  /**
   * 拿 MusicKit 实例：
   * getMusicKit() 过了令牌半衰期会重新 configure，那会打断正在放的东西，
   * 所以只有 instanceRef.current 为空、或它 playbackState 不是 playing / loading / waiting / seeking 时
   * 才允许再调 getMusicKit()；否则直接复用手上的。
   */
  const getOrReuseMusicKit = useCallback(async (): Promise<MusicKitInstance> => {
    const existing = instanceRef.current;
    if (existing && isPlaybackActive(existing)) {
      return existing;
    }
    const inst = await getMusicKit();
    instanceRef.current = inst;
    setInstance(inst);
    /*
     * 拿到手就对一次授权状态：MusicKit 把用户令牌存在本地，之前在「一起听」
     * 或上次访问登录过的话，configure 完 isAuthorized 直接是 true —— 事件
     * authorizationStatusDidChange 只在**变化**时来，初始值得自己读，否则登录
     * 过的访客打开播放器仍被画成试听。
     */
    setAuthorized(inst.isAuthorized);
    return inst;
  }, []);

  /**
   * 把一张专辑 / 歌单的队列装进实例，**不出声**。调用方负责排他链，这里不再
   * 套一层 —— 调用方已经在链里，再进一次会等自己，死锁。
   *
   * 不带 startPlaying：打开卡片就装队列，是为了让曲目列表马上可见；出声那一下
   * 留给播放键。未授权的实例也装得出目录队列（只是放不了），所以登录前就能看
   * 到列表。
   *
   * 每次装队列前都把音量和循环模式归位：实例是和「一起听」共用的单例，它预切
   * 时会把音量压到 0、主人单曲循环时会开 repeat one，交接过来若不清掉，这边
   * 放出来的就是哑的或者一首歌转圈。
   */
  const prepare = useCallback(async (inst: MusicKitInstance, targetItem: ListeningItem) => {
    const options = queueOptionsFor(targetItem);
    if (!options) {
      setStatus("idle");
      return;
    }
    setStatus("starting");
    setError(null);
    try {
      inst.volume = 1;
      applyRepeatMode(inst, false);
      // applyRepeatMode 顺手打开了 autoplay，那是跟听要接主人队列用的；这里放的是
      // 一张专辑，最后一首放完就该停，不要让 MusicKit 接着放 Apple 推荐的东西
      inst.autoplayEnabled = false;
      await mkSafe(() => inst.setQueue(options));
      // 避免慢网络下旧请求后发先至覆盖用户刚切换的新目标
      if (itemRef.current?.id === targetItem.id) {
        const items = inst.queue?.items ?? [];
        setCachedPlaylist(targetItem.id, items);
        loadedIdRef.current = targetItem.id;
        setLoadedId(targetItem.id);
        setQueue(items);
        setNowPlaying(inst.nowPlayingItem ?? null);
        setStatus("ready");
      }
    } catch (err) {
      if (itemRef.current?.id === targetItem.id) {
        loadedIdRef.current = null;
        setLoadedId(null);
        setError(describe(err));
        setStatus("error");
      }
    }
  }, []);

  /**
   * 停止并清队列，active 变 false（页头的缩略播放器随之消失）。
   *
   * MusicKit 的 stop 会把队列一起清掉；卡片还开着的话紧接着把这张专辑重新装
   * 回去 —— 列表不该因为按了停止就空掉，再按播放也不用先等一次装队列。
   */
  const stop = useCallback(() => {
    setActive(false);
    activeRef.current = false;
    loadedIdRef.current = null;
    setLoadedId(null);
    setPlaybackState(PLAYBACK_STATE.none);
    setQueue([]);
    setNowPlaying(null);
    setStatus(openRef.current ? "starting" : "idle");
    const inst = instanceRef.current;
    if (!inst) return;
    void runExclusive(async () => {
      await inst.stop().catch(() => {});
      const current = itemRef.current;
      if (openRef.current && current) await prepare(inst, current);
    });
  }, [prepare, runExclusive]);

  /**
   * 点了某张专辑：装入、打开弹窗、把队列装进实例，**不开播** —— 点封面是
   * 「看看这张」，要不要出声由卡片里的播放键决定。换成另一张时把正在放的停掉：
   * 播放器一次只认一张专辑，弹窗上写着新专辑、喇叭里放着旧的，会对不上。
   *
   * 若之前已拿过歌单列表有缓存，在打开弹窗前就直接预设好列表，并配合 Dialog
   * 预先算好像素高度，消除弹窗打开时的高度跳动；无缓存且非当前专辑时清空旧数据。
   *
   * MusicKit 那几百 KB 的脚本从这里开始拉：访客点开一张专辑就是要看曲目，
   * 列表只能从 MusicKit 的队列里来。
   */
  const openWith = useCallback(
    (targetItem: ListeningItem) => {
      const previousItem = itemRef.current;
      const switching = Boolean(previousItem && previousItem.id !== targetItem.id);
      const isLoaded = loadedIdRef.current === targetItem.id;
      const playable = queueOptionsFor(targetItem) !== null;
      const cached = getCachedPlaylist(targetItem.id);

      setItem(targetItem);
      itemRef.current = targetItem;
      setOpen(true);
      openRef.current = true;
      setError(null);

      // 若之前拿过歌单有缓存，弹窗打开前直接载入，消除弹窗首帧跳动与骨架屏闪烁
      if (cached && cached.length > 0) {
        loadedIdRef.current = targetItem.id;
        setLoadedId(targetItem.id);
        setQueue(cached);
        setNowPlaying(cached[0] ?? null);
        setStatus("ready");
      } else if (!isLoaded) {
        loadedIdRef.current = null;
        setLoadedId(null);
        setQueue([]);
        setNowPlaying(null);
        setStatus(playable ? "starting" : "idle");
      }

      const wasActive = activeRef.current;
      if (wasActive && switching) {
        setActive(false);
        activeRef.current = false;
        setPlaybackState(PLAYBACK_STATE.none);
      }

      if (!playable) return;

      void runExclusive(async () => {
        // 若实例已装载好该专辑且曲目存在，无需重新请求
        if (
          loadedIdRef.current === targetItem.id &&
          instanceRef.current?.queue?.items?.length
        ) {
          return;
        }

        // 无缓存时才展示 starting 占位；已有缓存展示时避免被打回 starting
        if (!cached || cached.length === 0) {
          setStatus("starting");
        }
        setError(null);
        let inst: MusicKitInstance;
        try {
          inst = await getOrReuseMusicKit();
        } catch (err) {
          setError(describe(err));
          setStatus("error");
          return;
        }

        if (wasActive && switching) {
          await inst.stop().catch(() => {});
        }

        // 等脚本的这几秒里访客可能已经点了别的专辑：装那张，别装过时的这张
        const latest = itemRef.current ?? targetItem;
        if (
          loadedIdRef.current === latest.id &&
          instanceRef.current?.queue?.items?.length
        ) {
          return;
        }
        await prepare(inst, latest);
      });
    },
    [getOrReuseMusicKit, prepare, runExclusive],
  );

  const openDialog = useCallback(() => setOpen(true), []);
  const closeDialog = useCallback(() => setOpen(false), []);

  /** 出过声就算 active：页头缩略播放器、底栏的 Stop 都看它 */
  const markActive = useCallback((inst: MusicKitInstance) => {
    setPlaybackState(inst.playbackState);
    setNowPlaying(inst.nowPlayingItem ?? null);
    setActive(true);
    activeRef.current = true;
  }, []);

  /** 弹窗里的 Sign in：加载 MusicKit 并 authorize，只登录不开播 */
  const signIn = useCallback(() => {
    void runExclusive(async () => {
      setStatus("starting");
      setError(null);
      try {
        const inst = await getOrReuseMusicKit();
        /*
         * 已经授权过就不再弹窗 —— MusicKit 把用户令牌存在本地，「一起听」那边
         * 登录过的话这里 isAuthorized 直接是 true。访客自己关掉授权弹窗也会走到
         * catch：不是故障，但也不该假装成功，把原因摆出来让他再点一次。
         */
        if (!inst.isAuthorized) await inst.authorize();
        setAuthorized(inst.isAuthorized);
        setStatus("idle");
        /*
         * 登录前已经在试听：队列里装的是 30 秒预览，授权不会把它们换成整首。
         * 停掉、按同一张专辑重装、再从头放，这次出来的才是完整曲目。
         */
        const current = itemRef.current;
        if (inst.isAuthorized && activeRef.current && current) {
          await inst.stop().catch(() => {});
          loadedIdRef.current = null;
          await prepare(inst, current);
          if (loadedIdRef.current !== current.id) return;
          await mkSafe(() => inst.play());
          markActive(inst);
        }
      } catch (err) {
        setError(describe(err));
        setStatus("error");
      }
    });
  }, [getOrReuseMusicKit, markActive, prepare, runExclusive]);

  /**
   * 播放键：队列没对上（装失败过、或被别处清掉）就先装，然后出声。
   *
   * 不看 isAuthorized：未授权的实例 MusicKit 会放每首 30 秒的试听，这是 Apple
   * 给的行为，拦不住也没必要拦 —— 弹窗上把它标成试听、把登录入口摆在旁边即可。
   */
  const play = useCallback(() => {
    void runExclusive(async () => {
      const inst = instanceRef.current;
      const currentItem = itemRef.current;
      if (!inst || !currentItem) return;
      if (loadedIdRef.current !== currentItem.id) {
        await prepare(inst, currentItem);
        if (loadedIdRef.current !== currentItem.id) return;
      }
      await mkSafe(() => inst.play());
      markActive(inst);
    });
  }, [markActive, prepare, runExclusive]);

  const pause = useCallback(() => {
    void runExclusive(async () => {
      const inst = instanceRef.current;
      if (!inst) return;
      await mkSafe(() => inst.pause());
    });
  }, [runExclusive]);

  const toggle = useCallback(() => {
    const inst = instanceRef.current;
    if (inst && activeRef.current && inst.playbackState === PLAYBACK_STATE.playing) {
      pause();
      return;
    }
    play();
  }, [pause, play]);

  const next = useCallback(() => {
    void runExclusive(async () => {
      const inst = instanceRef.current;
      if (!inst) return;
      await mkSafe(() => inst.skipToNextItem());
    });
  }, [runExclusive]);

  const previous = useCallback(() => {
    void runExclusive(async () => {
      const inst = instanceRef.current;
      if (!inst) return;
      await mkSafe(() => inst.skipToPreviousItem());
    });
  }, [runExclusive]);

  const seekTo = useCallback(
    (ms: number): Promise<void> => {
      return runExclusive(async () => {
        const inst = instanceRef.current;
        if (!inst) return;
        await mkSafe(() => inst.seekToTime(ms / 1000));
      });
    },
    [runExclusive],
  );

  /** 点队列里某一首：changeToMediaAtIndex 自己会开播，所以这里也要记 active */
  const playAt = useCallback(
    (index: number) => {
      void runExclusive(async () => {
        const inst = instanceRef.current;
        if (!inst) return;
        await mkSafe(() => inst.changeToMediaAtIndex(index));
        markActive(inst);
      });
    },
    [markActive, runExclusive],
  );

  /** 停止并 unauthorize */
  const logout = useCallback(() => {
    stop();
    const inst = instanceRef.current;
    if (!inst) {
      setError(null);
      return;
    }
    void (async () => {
      try {
        await inst.unauthorize();
        setAuthorized(false);
        setError(null);
      } catch (caught) {
        setError(describe(caught));
        setStatus("error");
      }
    })();
  }, [stop]);

  /**
   * 监听 MusicKit 实例的各项事件变化。
   * 注意：不要在这里监听 playbackTimeDidChange，避免每秒触发 Provider 全树重渲染。
   */
  useEffect(() => {
    const inst = instance;
    if (!inst) return;

    const onPlaybackState = () => {
      setPlaybackState(inst.playbackState);
    };
    const onNowPlaying = () => {
      if (loadedIdRef.current && loadedIdRef.current === itemRef.current?.id) {
        setNowPlaying(inst.nowPlayingItem ?? null);
      }
    };
    const onQueue = () => {
      if (loadedIdRef.current && loadedIdRef.current === itemRef.current?.id) {
        setQueue(inst.queue?.items ?? []);
      }
    };
    const onAuth = () => {
      const isAuth = inst.isAuthorized;
      setAuthorized(isAuth);
      if (!isAuth) {
        stop();
      }
    };

    inst.addEventListener("playbackStateDidChange", onPlaybackState);
    inst.addEventListener("nowPlayingItemDidChange", onNowPlaying);
    inst.addEventListener("queueItemsDidChange", onQueue);
    inst.addEventListener("authorizationStatusDidChange", onAuth);

    return () => {
      inst.removeEventListener("playbackStateDidChange", onPlaybackState);
      inst.removeEventListener("nowPlayingItemDidChange", onNowPlaying);
      inst.removeEventListener("queueItemsDidChange", onQueue);
      inst.removeEventListener("authorizationStatusDidChange", onAuth);
    };
  }, [instance, stop]);

  /** 页面/Hook 卸载时停止播放，避免音频遗留在后台 */
  useEffect(() => {
    return () => {
      if (instanceRef.current) {
        void instanceRef.current.stop().catch(() => {});
      }
    };
  }, []);

  const visibleQueue = resolveVisibleQueue(loadedId, item?.id, queue);
  const visibleNowPlaying = resolveVisibleQueue(loadedId, item?.id, [nowPlaying])[0] ?? null;

  return useMemo<WebPlayer>(
    () => ({
      status,
      authorized,
      error,
      item,
      open,
      playbackState,
      nowPlaying: visibleNowPlaying,
      queue: visibleQueue,
      active,
      instance,
      openWith,
      openDialog,
      closeDialog,
      signIn,
      play,
      pause,
      toggle,
      next,
      previous,
      seekTo,
      playAt,
      stop,
      logout,
    }),
    [
      status,
      authorized,
      error,
      item,
      open,
      playbackState,
      visibleNowPlaying,
      visibleQueue,
      active,
      instance,
      openWith,
      openDialog,
      closeDialog,
      signIn,
      play,
      pause,
      toggle,
      next,
      previous,
      seekTo,
      playAt,
      stop,
      logout,
    ],
  );
}
