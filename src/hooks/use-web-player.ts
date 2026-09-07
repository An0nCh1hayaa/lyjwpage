"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

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
  fetchCatalogTracks,
  filterUserQueueItems,
  getCachedPlaylist,
  getMusicAuthServerSnapshot,
  getMusicAuthSnapshot,
  queueOptionsFor,
  setCachedPlaylist,
  setMusicAuthSnapshot,
  subscribeMusicAuth,
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
  /** 弹窗正在查看的那张专辑 / 歌单；null 表示没有 */
  item: ListeningItem | null;
  /** 底层正在播放的那张专辑 / 歌单；null 表示没有在放 */
  activeItem: ListeningItem | null;
  /** 弹窗查看的专辑是否正是当前正在播放的专辑 */
  isItemActive: boolean;
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
  /** 点了某张专辑：装入、打开弹窗，不开播；如果已有正在播放的音乐，不会打断播放 */
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

const setAuthorized = setMusicAuthSnapshot;

export function useWebPlayerState(): WebPlayer {
  const [status, setStatus] = useState<WebPlayerStatus>(
    MUSICKIT_TOKEN_ENDPOINT ? "idle" : "unavailable",
  );
  const authorized = useSyncExternalStore(
    subscribeMusicAuth,
    getMusicAuthSnapshot,
    getMusicAuthServerSnapshot,
  );
  const [error, setError] = useState<string | null>(null);
  const [item, setItem] = useState<ListeningItem | null>(null);
  const [activeItem, setActiveItem] = useState<ListeningItem | null>(null);
  const [open, setOpen] = useState(false);
  const [playbackState, setPlaybackState] = useState<number>(PLAYBACK_STATE.none);
  const [nowPlaying, setNowPlaying] = useState<MediaItem | null>(null);
  const [queue, setQueue] = useState<MediaItem[]>([]);
  const [active, setActive] = useState(false);
  const [instance, setInstance] = useState<MusicKitInstance | null>(null);

  const instanceRef = useRef<MusicKitInstance | null>(null);
  const itemRef = useRef<ListeningItem | null>(null);
  const activeItemRef = useRef<ListeningItem | null>(null);
  const activeRef = useRef(false);
  const openRef = useRef(false);
  /** 实例里此刻装着哪张专辑的队列。stop 会把队列清掉，那时归 null，下次要重装 */
  const loadedIdRef = useRef<string | null>(null);

  useEffect(() => {
    itemRef.current = item;
  }, [item]);

  useEffect(() => {
    activeItemRef.current = activeItem;
  }, [activeItem]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const isItemActive = Boolean(
    active && item && activeItem && item.id === activeItem.id,
  );

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
      setAuthorized(existing.isAuthorized);
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

  // 弹窗打开时后台校验/预热 MusicKit 实例，同步最新授权状态并就绪播放器，无需等待用户点击播放
  useEffect(() => {
    if (!open) return;
    void getOrReuseMusicKit().catch(() => {});
  }, [open, getOrReuseMusicKit]);

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
      await mkSafe(() => inst.setQueue(options));
      // setQueue 内部切换 PlaybackController 会重新挂载并可能触发 startAutoplay；
      // 装完队列后显式关掉 autoplayEnabled，触发 stopAutoplay 清除推荐曲目
      inst.autoplayEnabled = false;

      // 优先保留 Catalog API 获得的权威专辑曲目；若无则从实例队列中提取非 Autoplay 的真实曲目
      const existingCached = getCachedPlaylist(targetItem.id);
      const items =
        existingCached && existingCached.length > 0
          ? existingCached
          : filterUserQueueItems(inst);

      if (items.length > 0) {
        setCachedPlaylist(targetItem.id, items);
      }
      loadedIdRef.current = targetItem.id;
      if (itemRef.current?.id === targetItem.id) {
        setQueue(items);
        setNowPlaying(inst.nowPlayingItem ?? items[0] ?? null);
        setStatus("ready");
      }
    } catch (err) {
      if (itemRef.current?.id === targetItem.id) {
        loadedIdRef.current = null;
        setError(describe(err));
        setStatus("error");
      }
    }
  }, []);

  /**
   * 停止播放，清除 active 状态（页头的缩略播放器随之消失）。
   * 弹窗保持当前专辑和曲目列表可见，底栏播放键恢复为 Play，用户可随时重新开播。
   */
  const stop = useCallback(() => {
    setActive(false);
    activeRef.current = false;
    setActiveItem(null);
    activeItemRef.current = null;
    loadedIdRef.current = null;
    setPlaybackState(PLAYBACK_STATE.none);
    setNowPlaying(null);
    const inst = instanceRef.current;
    if (!inst) return;
    void runExclusive(async () => {
      await inst.stop().catch(() => {});
    });
  }, [runExclusive]);

  /**
   * 点了某张专辑：装入、打开弹窗，**不开播**。
   * 如果当前已经有正在播放的音乐，不会打断正在播放的音频流；
   * 通过只读 API / 缓存拉取目标专辑曲目，待用户真正点击播放时才切歌开播。
   *
   * 若之前已拿过歌单列表有缓存，在打开弹窗前就直接预设好列表，并配合 Dialog
   * 预先算好像素高度，消除弹窗打开时的高度跳动；无缓存且非当前专辑时清空旧数据。
   */
  const openWith = useCallback(
    (targetItem: ListeningItem) => {
      setItem(targetItem);
      itemRef.current = targetItem;
      setOpen(true);
      openRef.current = true;
      setError(null);
      void getOrReuseMusicKit().catch(() => {});

      const isCurrentActive =
        activeRef.current && activeItemRef.current?.id === targetItem.id;
      const cached = getCachedPlaylist(targetItem.id);
      const isLoaded = loadedIdRef.current === targetItem.id;
      const playable = queueOptionsFor(targetItem) !== null;

      // 若之前拿过歌单有缓存，弹窗打开前直接载入，消除弹窗首帧跳动与骨架屏闪烁
      if (cached && cached.length > 0) {
        setQueue(cached);
        setNowPlaying(
          isCurrentActive
            ? (instanceRef.current?.nowPlayingItem ?? cached[0] ?? null)
            : null,
        );
        setStatus("ready");
      } else if (isLoaded && instanceRef.current?.queue) {
        const items = filterUserQueueItems(instanceRef.current);
        if (items.length > 0) {
          setCachedPlaylist(targetItem.id, items);
          setQueue(items);
          setNowPlaying(
            isCurrentActive
              ? (instanceRef.current.nowPlayingItem ?? items[0] ?? null)
              : null,
          );
          setStatus("ready");
        } else {
          setQueue([]);
          setNowPlaying(null);
          setStatus(playable ? "starting" : "idle");
        }
      } else {
        setQueue([]);
        setNowPlaying(null);
        setStatus(playable ? "starting" : "idle");
      }

      if (!playable) return;

      // 如果已有曲目列表，无需再次请求
      if (cached && cached.length > 0) return;
      if (isLoaded && instanceRef.current?.queue?.items?.length) return;

      // 纯异步拉取曲目，不打断正在播放的音频
      void (async () => {
        try {
          const tracks = await fetchCatalogTracks(targetItem, instanceRef.current);
          if (tracks.length > 0) {
            setCachedPlaylist(targetItem.id, tracks);
            if (itemRef.current?.id === targetItem.id) {
              setQueue(tracks);
              const activeNow =
                activeRef.current && activeItemRef.current?.id === targetItem.id;
              setNowPlaying(
                activeNow
                  ? (instanceRef.current?.nowPlayingItem ?? tracks[0] ?? null)
                  : null,
              );
              setStatus("ready");
            }
          } else {
            // 若只读 API 未查到曲目，且当前没有正在播放的音乐，回退到 prepare (setQueue)
            if (!activeRef.current) {
              void runExclusive(async () => {
                if (itemRef.current?.id !== targetItem.id) return;
                let inst: MusicKitInstance;
                try {
                  inst = await getOrReuseMusicKit();
                } catch (err) {
                  setError(describe(err));
                  setStatus("error");
                  return;
                }
                if (itemRef.current?.id === targetItem.id) {
                  await prepare(inst, targetItem);
                }
              });
            } else if (itemRef.current?.id === targetItem.id) {
              setStatus("ready");
            }
          }
        } catch (err) {
          if (itemRef.current?.id === targetItem.id) {
            setError(describe(err));
            setStatus("error");
          }
        }
      })();
    },
    [getOrReuseMusicKit, prepare, runExclusive],
  );

  const openDialog = useCallback(() => {
    setOpen(true);
    openRef.current = true;
    void getOrReuseMusicKit().catch(() => {});
  }, [getOrReuseMusicKit]);
  const closeDialog = useCallback(() => {
    setOpen(false);
    openRef.current = false;
  }, []);

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
        setStatus("ready");
        /*
         * 登录前已经在试听：队列里装的是 30 秒预览，授权不会把它们换成整首。
         * 停掉、按同一张专辑重装、再从头放，这次出来的才是完整曲目。
         */
        const activeCur = activeItemRef.current;
        if (inst.isAuthorized && activeRef.current && activeCur) {
          await inst.stop().catch(() => {});
          loadedIdRef.current = null;
          await prepare(inst, activeCur);
          if (loadedIdRef.current !== activeCur.id) return;
          inst.autoplayEnabled = false;
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
   * 播放键：队列没装时装队列开播，装了就是续播。未授权时放的是 30 秒试听。
   * 若查看的专辑与当前正在播放的不同，停旧播、装新队并开播。
   */
  const play = useCallback(() => {
    void runExclusive(async () => {
      const currentItem = itemRef.current;
      if (!currentItem) return;

      setStatus("starting");
      setError(null);
      let inst: MusicKitInstance;
      try {
        inst = await getOrReuseMusicKit();
      } catch (err) {
        setError(describe(err));
        setStatus("error");
        return;
      }

      if (loadedIdRef.current !== currentItem.id) {
        await inst.stop().catch(() => {});
        await prepare(inst, currentItem);
        if (loadedIdRef.current !== currentItem.id) return;
      }

      inst.autoplayEnabled = false;
      await mkSafe(() => inst.play());
      setActiveItem(currentItem);
      activeItemRef.current = currentItem;
      markActive(inst);
    });
  }, [getOrReuseMusicKit, markActive, prepare, runExclusive]);

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
      if (openRef.current && itemRef.current?.id !== activeItemRef.current?.id) {
        play();
        return;
      }
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
        const currentItem = itemRef.current;
        if (!currentItem) return;

        let inst: MusicKitInstance;
        try {
          inst = await getOrReuseMusicKit();
        } catch (err) {
          setError(describe(err));
          setStatus("error");
          return;
        }

        if (loadedIdRef.current !== currentItem.id) {
          await inst.stop().catch(() => {});
          await prepare(inst, currentItem);
          if (loadedIdRef.current !== currentItem.id) return;
        }

        inst.autoplayEnabled = false;
        await mkSafe(() => inst.changeToMediaAtIndex(index));
        setActiveItem(currentItem);
        activeItemRef.current = currentItem;
        markActive(inst);
      });
    },
    [getOrReuseMusicKit, markActive, prepare, runExclusive],
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
      if (activeItemRef.current?.id === itemRef.current?.id) {
        setNowPlaying(inst.nowPlayingItem ?? null);
      }
    };
    const onQueue = () => {
      const currentLoadedId = loadedIdRef.current;
      if (!currentLoadedId || currentLoadedId !== itemRef.current?.id) return;

      // 如果已有权威曲目列表（如 Catalog API 返回的专辑完整曲目），绝不让 Autoplay 推荐队列覆盖
      const existing = getCachedPlaylist(currentLoadedId);
      if (existing && existing.length > 0) return;

      const items = filterUserQueueItems(inst);
      if (items.length > 0) {
        setCachedPlaylist(currentLoadedId, items);
        setQueue(items);
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

  const visibleNowPlaying = isItemActive ? nowPlaying : null;

  return useMemo<WebPlayer>(
    () => ({
      status,
      authorized,
      error,
      item,
      activeItem,
      isItemActive,
      open,
      playbackState,
      nowPlaying: visibleNowPlaying,
      queue,
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
      activeItem,
      isItemActive,
      open,
      playbackState,
      visibleNowPlaying,
      queue,
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
