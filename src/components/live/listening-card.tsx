"use client";

import NumberFlow, { NumberFlowGroup } from "@number-flow/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Image from "next/image";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { Card } from "@/components/ui/card";
import { HomePodMiniIcon, MacBookProIcon } from "@/components/ui/device-icons";
import {
  HeroLyrics,
  HeroLyricsSkeleton,
  LYRIC_LINE_VARIANTS,
  LyricWords,
} from "@/components/live/hero-lyrics";
import { HeroMotionArtwork } from "@/components/live/hero-motion-artwork";
import { ListenAlongButton } from "@/components/live/listen-along-button";
import { PlayerArtworkPreload } from "@/components/web-player/player-artwork";
import { useWebPlayer } from "@/components/web-player/web-player-provider";
import { useListenAlong } from "@/hooks/use-listen-along";
import { useLiveEvents } from "@/hooks/use-live-events";
import { useLyrics, type LyricsFallback } from "@/hooks/use-lyrics";
import { useMotionArtwork } from "@/hooks/use-motion-artwork";
import { useMountedAt } from "@/hooks/use-mounted-at";
import { useExpiryRefetch, useStatus } from "@/hooks/use-status";
import { stableKeys } from "@/lib/keys";
import { cueAt, NO_CUE } from "@/lib/lyrics-cue";
import type { LyricLine } from "@/lib/lyrics-ttml";
import {
  HERO_VARIANTS,
  LIST_DURATION,
  LIST_ITEM_VARIANTS,
  LIST_TRANSITION,
  STATIC_TRANSITION,
  STATIC_VARIANTS,
} from "@/lib/motion";
import { LISTENING_PATH, NOW_LISTENING_PATH } from "@/lib/paths";
import { trackPositionMs } from "@/lib/track-position";
import type {
  ListeningItem,
  ListeningPayload,
  LocalNowPlaying,
  NowListeningPayload,
  StatusResponse,
} from "@/lib/types";
import { appleArtwork, ARTWORK_SCALE, needsOptimizing } from "@/lib/apple-artwork";
import type { ArtworkDataUri, ArtworkPlaceholders } from "@/lib/artwork-placeholder";
import { queueOptionsFor } from "@/lib/web-player";
import { cn } from "@/lib/utils";

/**
 * 列表变了会把完整数据推过来，轮询只兜「推送整体停用」这一种情况，所以给得很松。
 * 从前是 30 秒，那时列表要靠轮询才会翻 —— 服务端还得现打 Apple 的目录接口。
 */
const REFRESH_MS = 10 * 60_000;
/**
 * 手上一份都没有时的那一档。
 *
 * 空着的时候松不得。这份列表现在由**访客自己的请求**触发去拉（见
 * lib/apple-music-recent），所以冷启动那一下 —— 新部署、SQLite 被清空 —— 第一个
 * 访客的首屏必然是空的，数据要等他这次请求在响应之后刷完才落库，落完靠推送送达。
 * 而推送没配（`NEXT_PUBLIC_BACKEND_URL` 是可以不填的，那时「页面只靠轮询更新」）
 * 或 WebSocket 恰好还没连上时，就只剩轮询这一条路 —— 上面那档意味着卡片顶着一句
 * 「Apple Music 未连接」站十分钟，而实际上数据一秒后就在库里了。
 *
 * 代价说清楚：凭据压根没配的部署上这一档会一直开着，每个标签页每小时多打几十次
 * 状态端点（读的是缓存快照，不会传导到 Apple —— 回源频率由那边的 TTL 管）。
 * 那是「没配好」这件事本身的动静，不该由把它藏起来的方式解决。
 */
const EMPTY_REFRESH_MS = 60_000;
/** 实时播放由推送送来，轮询只是兜底 */
const MUSIC_REFRESH_MS = 60_000;

/**
 * 视口里显示几行。行高不写死：列表填满卡片剩下的空间，每行取容器的 1/N
 * （grid-auto-rows: calc(100% / N)），所以永远是整数行、底部也不会留空。
 * 这件事 CSS 自己就能算，不需要 JS 去量。
 *
 * 窄屏和桌面半宽都横滑两页，每页就是这么多行，一共 8 条。上游最多 10 条，
 * hero 还可能并掉一条，8 刚好两页。第九条起不展示。
 */
const VISIBLE_ROWS = 4;
/** 单行的最小高度：44px 封面 + 上下留白，比这个再矮就挤了 */
const MIN_ROW_HEIGHT_PX = 56;

/**
 * 专辑 / 歌单总时长。超过一小时给 h:mm:ss，否则 m:ss。
 *
 * 不用上面那个 Clock：那个是给会走的进度用的，滚动数字有意义；总时长是死的，
 * 而且 hero 一换就整个重挂、NumberFlow 拿不到上一个值，本来也滚不起来。
 * 歌单动辄一两个小时，75:09 这种写法读起来别扭。
 */
function formatDuration(milliseconds: number) {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/**
 * 把封面取色拼成那条彩虹的渐变。
 *
 * Apple 给的五个色不能直接用：textColor 是设计来叠在 bgColor 上的，浅色封面
 * 配近黑、深色封面配浅色，原样画出来一半的专辑会得到一条几乎全黑的线。
 * `oklch(from …)` 只留色相、把亮度和彩度按住在可见区间，这样每张封面都出一条
 * 看得见、又确实是它自己颜色的带子。换算交给 CSS，不在 JS 里写颜色数学。
 *
 * 首尾补回第一个色，配 background-size: 200% 才能无缝循环。取不到调色板就返回
 * undefined，让 .rainbow-bar 自带的那条通用彩虹兜底。
 */
function paletteGradient(palette: string[]): string | undefined {
  if (palette.length < 2) return undefined;
  const stops = [...palette, palette[0]]
    .map((color) => (color.startsWith("#") ? color : `#${color}`))
    .map((color) => `oklch(from ${color} 0.74 max(c, 0.09) h)`)
    .join(", ");
  return `linear-gradient(90deg, ${stops})`;
}

/**
 * 一条跟着封面配色走的带子，两层叠着交叉淡入。
 *
 * 动态封面的取色比静态封面晚到几百毫秒，而 `background-image` 不参与过渡 ——
 * 直接换那一下颜色是「啪」地跳过去的。所以底层始终画静态封面那套
 * （没有调色板就退回绿色或暂停时的灰色），动态那套取到了再淡进来。
 *
 * 上层从一开始就挂着、只是 opacity 0：两层的 rainbow-drift 得同时起步才同相。
 * 等要用时才挂载的话新层动画从头跑，和底层错开，交叉淡入的中途会看出两道颜色
 * 在互相错动。
 */
function PaletteBar({
  base,
  motion: motionGradient,
  idleClassName,
  className,
  style,
}: {
  base?: string;
  motion?: string;
  idleClassName?: string;
  className?: string;
  style?: CSSProperties;
}) {
  /**
   * 暂停时调用方会把 motion 清掉。上层始终挂着 .rainbow-bar，内联背景一摘，
   * CSS 那条通用彩虹就会露出来，再花 700ms 淡成灰 —— 看起来像跳成另一种彩条。
   *
   * callback ref 在 commit 阶段才写 DOM：有新颜色就替换，motion 清空时什么都
   * 不做，让节点保留上一套背景并同时把 opacity 切到 0。这样行为和原来一致，
   * 又不会在并发渲染期间读写 ref。
   */
  const rememberMotionGradient = useCallback(
    (node: HTMLDivElement | null) => {
      if (node && motionGradient) node.style.backgroundImage = motionGradient;
    },
    [motionGradient],
  );

  return (
    <div className={cn("relative", className)} style={style} aria-hidden>
      <div
        className={cn("absolute inset-0", base ? "rainbow-bar" : idleClassName)}
        style={{ backgroundImage: base }}
      />
      {/* rainbow-bar 不能跟着 opacity 一起切：CSS 动画从元素命中规则那刻起算，
          等淡入时才加就等于让上层的 drift 从头跑，和底层错开相位。 */}
      <div
        ref={rememberMotionGradient}
        className={cn(
          "rainbow-bar absolute inset-0 transition-opacity ease-out",
          motionGradient ? "opacity-100 duration-700" : "opacity-0 duration-0",
        )}
      />
    </div>
  );
}

/**
 * 三根竖条。设备说在播时跳动，否则静止成一个普通的音乐小图标。
 *
 * 动画相位挂在墙上时钟，不挂在挂载时刻。换歌时整个 hero 会重新挂载，CSS 动画
 * 默认从头开始，三根条齐刷刷跳回起点 —— 从前 mode="wait" 中间空一拍把这一下
 * 盖住了，改成交叉淡入后新旧同时可见，顿挫就露出来了。
 *
 * 负的 animation-delay 表示「已经播过这么久」：取 now % period，任何时刻新挂载
 * 的实例都落在和旧实例相同的相位上，接得上。重渲染时重算也是幂等的 —— 算出来
 * 的还是当前相位，不会自己把自己顿一下。
 *
 * 不用担心和服务端对不上：相位是在 ref 回调（提交阶段）里写进 DOM 的，
 * 服务端根本不跑那一段，首屏 HTML 里这三根条不带 animation-delay。
 */
const BAR_PERIODS = [0.9, 1.15, 1.4];

/**
 * 三种状态，不是两种。
 *
 * - playing 在跳
 * - paused  就地冻住。keyframes 动的是 transform: scaleY，所以只要保住 h-full
 *   这个基准盒、把 animation-play-state 切成 paused，浏览器就停在当前那一帧上。
 *   从前这一档和 idle 合并了，一按暂停三根条会弹回固定形状 —— 明明只是暂停，
 *   看起来却像换了个东西。
 * - idle    历史条目，从来没跳过，没有「当前姿态」可冻，用固定形状
 */
type BarsState = "playing" | "paused" | "idle";

function Bars({ state }: { state: BarsState }) {
  const idleHeights = ["h-2", "h-3", "h-1.5"];
  const animated = state !== "idle";

  /**
   * 在 ref 回调里对相位，不在渲染里。
   *
   * Date.now 是不纯的，渲染期调用会被 react-hooks 拦下（结果也确实不稳定）。
   * ref 回调跑在 commit 阶段、绘制之前，既保住渲染纯粹，也不会先闪一帧相位 0。
   *
   * paused 也要对：直接以暂停态挂载时（刷新页面时曲子正暂停着），不对的话三根
   * 条会齐刷刷停在 scaleY(0.3)，像根本没播过。playing→paused 那次重跑是幂等的，
   * 算出来还是当前相位，冻住的姿态不会被挪动。
   */
  const alignPhase = useCallback(
    (node: HTMLSpanElement | null) => {
      if (!node || !animated) return;
      const seconds = Date.now() / 1000;
      [...node.children].forEach((child, i) => {
        const period = BAR_PERIODS[i];
        // 错开的起点保留原来的观感；周期本来就各不相同，跳起来不会齐步走
        (child as HTMLElement).style.animationDelay =
          `${(-((seconds % period) + i * 0.15)).toFixed(3)}s`;
      });
    },
    [animated],
  );

  return (
    <span className="flex h-3 items-end gap-0.5" aria-hidden ref={alignPhase}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={cn(
            "w-0.5 origin-bottom",
            state === "idle"
              ? `bg-muted-foreground ${idleHeights[i]}`
              : state === "playing"
                ? "h-full bg-live"
                : "h-full bg-muted-foreground",
          )}
          style={
            animated
              ? {
                  animation: `equalizer ${BAR_PERIODS[i]}s ease-in-out infinite`,
                  // 值本身不变，React 只会补上这一条，动画不会被重置
                  animationPlayState: state === "paused" ? "paused" : "running",
                }
              : undefined
          }
        />
      ))}
    </span>
  );
}

/**
 * 时钟的一格，秒进位时和充电头的瓦数一样滚动。
 *
 * 分秒拆成两个 NumberFlow 而不是把 "2:19" 当一个数字：冒号不是千分位那类
 * 分隔符，Intl 也没有 mm:ss 的格式，只能自己拼。外面套 NumberFlowGroup 才能
 * 让 59→00 那一下两格同时翻，否则各滚各的、时间差看得出来。
 *
 * 秒补零交给 minimumIntegerDigits，不用 padStart —— 字符串补出来的零是静态
 * 文本，滚动时那一位不会动。
 */
function Clock({ milliseconds }: { milliseconds: number }) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  return (
    <>
      <NumberFlow value={Math.floor(seconds / 60)} locales="en-US" />
      <span>:</span>
      <NumberFlow
        value={seconds % 60}
        locales="en-US"
        format={{ minimumIntegerDigits: 2 }}
      />
    </>
  );
}

/**
 * 本机曲目的副标题行 + 进度条。
 *
 * 挤进 hero 而不撑高它：hero 的高度由 80px 封面定死，文字列实测只用掉 67px，
 * 剩 13px。时间放进副标题行右侧（那一行本来就存在，label-mono 是 11px/行高 1，
 * 比 text-sm 的 20px 行盒矮，只占宽度不占高度），进度条另起一行占 3+6=9px，
 * 合计 76px，仍在 80px 之内。
 *
 * 秒级计时器留在这个组件里，不放到 ListeningCard —— 否则下面那个带布局动画的
 * 列表会跟着每秒重渲染一次。
 *
 * 有同步歌词时副标题那一行跟着进度走：唱到哪句就换成哪句，前奏、间奏和没有
 * 歌词时是艺人名。位置不另起一行 —— hero 的 80px 已经用掉 76px，多一行就得撑高，
 * 而两版 hero 的高度必须一致（见下面渲染处的注释）。哪句该亮由 lib/lyrics-cue
 * 按同一个 position 算，所以它和进度条、和「一起听」读的是同一个时刻。
 */
function HeroProgress({
  track,
  subtitle,
  palette,
  motionGradient,
  lyrics,
  sideLyrics = false,
}: {
  track: LocalNowPlaying;
  subtitle: string;
  palette?: string[];
  motionGradient?: string;
  /** 按 startMs 升序的同步歌词；没有就是 null，副标题行只显示艺人名 */
  lyrics: LyricLine[] | null;
  /** 宽屏且右侧有独立歌词栏时为 true，副标题行在桌面端恢复显示艺人名 */
  sideLyrics?: boolean;
}) {
  const playing = track.state === "playing";
  const reduced = useReducedMotion();
  /**
   * 首帧 now 是 0（见 useMountedAt），服务端只画锚点、进度不往前推 —— 服务端算
   * 的偏移和 hydrate 那一刻算的必然差着毫秒，时间文本和进度条宽度都会对不上。
   * 往前推留给客户端，和「最近在看」那排卡片的进度条同一个思路。
   *
   * 不用为首帧另开分支：下面 max(0, 0 - observedAt) 本来就是 0。
   */
  const mountedAt = useMountedAt();
  const [ticked, setTicked] = useState(0);
  const now = ticked || mountedAt;

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setTicked(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [playing]);

  // 推算规则和「一起听」共用一份，见 lib/track-position —— 两边各写一遍的话，
  // 画在进度条上的和访客耳朵里放的会慢慢错开，还看不出是谁错了
  const position = trackPositionMs(track, now);
  const percent = track.durationMs ? (position / track.durationMs) * 100 : 0;
  const gradient = palette && palette.length >= 2 ? paletteGradient(palette) : undefined;

  /**
   * 换句的那一刻单独定一个闹钟，不靠上面那个秒级计时器。
   *
   * 一句歌词两三秒，按整秒对齐最坏晚一秒才换，唱到下一句了字还是上一句的。
   * 闹钟定在下一次结论会变的位置（下一句开口、这句唱完、或单曲循环绕回开头），
   * 响了就把 now 拨到当下，渲染那边按同一份 position 算出的自然就是新的那句。
   * 暂停时不定：position 不走，结论也不会变。
   *
   * `now` 进依赖是有意的：每次拨钟（整秒或闹钟）都重新按当下的 position 定下一个，
   * 手上的锚点变了（换歌、拖进度）也一样。
   */
  const { observedAt, positionMs, durationMs, repeatOne } = track;
  useEffect(() => {
    if (!playing || !lyrics) return;
    const anchor = { state: "playing" as const, observedAt, positionMs, durationMs, repeatOne };
    const at = trackPositionMs(anchor, Math.max(now, Date.now()));
    const { until } = cueAt(lyrics, at);
    const target = until ?? (repeatOne && durationMs > 0 ? durationMs : null);
    if (target == null) return;
    // 多留几毫秒：闹钟绝不会早响，但要保证响的时候 position 已经过了边界
    const timer = window.setTimeout(() => setTicked(Date.now()), Math.max(16, target - at + 8));
    return () => window.clearTimeout(timer);
  }, [playing, lyrics, now, observedAt, positionMs, durationMs, repeatOne]);

  const cue = lyrics ? cueAt(lyrics, position) : NO_CUE;
  const current = cue.index >= 0 ? lyrics![cue.index] : null;
  const line = current?.text ?? null;

  return (
    <>
      <div className="mt-px flex items-baseline gap-2 text-sm text-muted-foreground">
        {/*
          艺人名和歌词句交叉淡入：popLayout 把离场的那句摘出文档流叠在原位，
          新句直接顶上，行高不变。外层 relative + overflow-hidden 给离场那句一个
          可以绝对定位、又不会露出去的框。key 用句子的下标：同一句词在一首歌里
          可能重复出现，按文字当 key 的话副歌第二遍不会触发换句。
        */}
        <span
          className="relative min-w-0 flex-1 overflow-hidden"
          title={sideLyrics ? subtitle : (line ?? subtitle)}
        >
          {sideLyrics ? (
            /* 宽屏桌面端在右侧独立显示歌词，副标题行恢复展示艺人名 */
            <span className="block truncate">{subtitle}</span>
          ) : (
            <>
              {/* 桌面半宽状态下空间受限，副标题行跟唱歌词 */}
              <span className="hidden md:block">
                <AnimatePresence initial={false} mode="popLayout">
                  <motion.span
                    key={cue.index}
                    className={cn("block truncate", line != null && "text-foreground")}
                    variants={reduced ? STATIC_VARIANTS : LYRIC_LINE_VARIANTS}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                  >
                    {current?.words ? (
                      <LyricWords words={current.words} track={track} />
                    ) : (
                      (line ?? subtitle)
                    )}
                  </motion.span>
                </AnimatePresence>
              </span>
              {/* 移动端另起独立歌词区域，副标题行始终展示艺人名 */}
              <span className="block truncate md:hidden">{subtitle}</span>
            </>
          )}
        </span>
        <NumberFlowGroup>
          <span className="label-mono shrink-0 tabular-nums">
            <Clock milliseconds={position} />
            <span> / </span>
            <Clock milliseconds={track.durationMs} />
          </span>
        </NumberFlowGroup>
      </div>
      <div className="mt-1.5 h-0.75 overflow-hidden bg-muted">
        {/* 暂停时不分层：一条静的灰带子，没有颜色好过渡 */}
        <PaletteBar
          className="h-full transition-[width] duration-700 ease-linear"
          base={playing ? gradient : undefined}
          motion={playing ? motionGradient : undefined}
          idleClassName={playing ? "bg-live" : "bg-muted-foreground"}
          style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
        />
      </div>
    </>
  );
}

function TrackRow({
  track,
  placeholder,
  onOpen,
}: {
  track: ListeningItem;
  placeholder: ArtworkDataUri | undefined;
  onOpen?: () => void;
}) {
  const content = (
    <>
      <div className="relative size-11 shrink-0 overflow-hidden rounded-sm border border-line bg-muted">
        {/*
         * 低清占位垫在真图下层，和 hero 同一套（见 hero-motion-artwork）：
         * 走 `placeholder` 属性的话它是 CSS 背景图、没有 decoding 可控，移动端
         * 水合期背景解码会滑过首帧一两拍，露出底下的 bg-muted 灰闪一下 ——
         * 行的真图是 lazy，到得比 hero 更晚，那一下更藏不住。data URI + sync
         * 解码由浏览器保证与首帧原子绘制，真图排在它后面，加载完自然盖住。
         * 九张小图同步解码合计约 1~2ms，换掉首帧那一闪值得。
         */}
        {placeholder && (
          <Image
            src={placeholder}
            alt=""
            aria-hidden
            fill
            sizes="44px"
            className="object-cover"
            decoding="sync"
          />
        )}
        {track.artwork && (
          <Image
            src={appleArtwork(track.artwork, 44 * ARTWORK_SCALE)!}
            alt=""
            fill
            sizes="44px"
            className="object-cover"
            unoptimized={!needsOptimizing(track.artwork)}
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{track.title}</div>
        <div className="truncate text-xs text-muted-foreground">
          {track.artist}
        </div>
      </div>
    </>
  );

  // 高度和吸附交给外层的 motion 包装，这里只管行内布局
  const className =
    "flex h-full items-center gap-2.5 rounded-md px-2 transition-colors hover:bg-surface-hover";

  if (onOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className={cn(className, "w-full text-left")}
      >
        {content}
      </button>
    );
  }

  return track.link ? (
    <a
      href={track.link}
      target="_blank"
      rel="noreferrer noopener"
      className={className}
    >
      {content}
    </a>
  ) : (
    <div className={className}>{content}</div>
  );
}

function dedupeListeningItems(items: ListeningItem[], currentId: string | null) {
  const seen = new Set<string>();

  return items.filter((item) => {
    if (currentId && item.id === currentId) return false;
    if (!item.id) return true;
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

/** 占位行。高度由 grid 轨道给，和 TrackRow 一样，加载完不会跳 */
function SkeletonRow() {
  return (
    <div className="flex h-full items-center gap-2.5 px-2">
      <div className="size-11 shrink-0 animate-pulse rounded-sm bg-muted" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="h-3 w-2/5 animate-pulse rounded bg-muted" />
        <div className="h-2.5 w-1/4 animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}

// 服务端没有 layout 阶段，useLayoutEffect 会告警，这里按环境切换
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/** 横滑摘掉 CSS 吸附的窗口。比动画本身多留一点，计时是动画开跑之后才起的。 */
const UNSNAP_MS = LIST_DURATION * 1000 + 80;

function resetScroller(el: HTMLElement) {
  const saved = el.style.scrollBehavior;
  el.style.scrollBehavior = "auto";
  el.scrollTop = 0;
  el.scrollLeft = 0;
  el.style.scrollBehavior = saved;
}

/**
 * 顶部换人或切宽窄时拉回第一页。横滑吸附交给 CSS scroll-snap，
 * 增删时的冲突由外面那层 is-reflowing 在动画窗口里摘掉吸附来躲。
 */
function useRowSnap(topKey: string | undefined, wide: boolean) {
  const node = useRef<HTMLDivElement | null>(null);
  const previous = useRef(topKey);

  useIsomorphicLayoutEffect(() => {
    if (previous.current === topKey) return;
    previous.current = topKey;
    const el = node.current;
    if (!el || (el.scrollTop === 0 && el.scrollLeft === 0)) return;
    resetScroller(el);
  }, [topKey]);

  useIsomorphicLayoutEffect(() => {
    if (!node.current) return;
    resetScroller(node.current);
  }, [wide]);

  return useCallback((el: HTMLDivElement | null) => {
    node.current = el;
  }, []);
}

/** 有链接或点击打开回调就整块可点，没有就退化成普通容器 */
function HeroWrapper({
  link,
  wideLyrics = false,
  onOpen,
  children,
}: {
  link: string | null;
  wideLyrics?: boolean;
  onOpen?: () => void;
  children: ReactNode;
}) {
  // 移动端始终为全宽 flex 排布；仅在桌面端开启宽屏歌词时切换为双列 grid
  const className = cn(
    "group h-full rounded-md",
    wideLyrics ? "flex gap-3 md:grid md:grid-cols-2 md:gap-0" : "flex gap-3",
  );
  if (onOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className={cn(className, "w-full text-left")}
      >
        {children}
      </button>
    );
  }
  return link ? (
    <a
      href={link}
      target="_blank"
      rel="noreferrer noopener"
      className={className}
    >
      {children}
    </a>
  ) : (
    <div className={className}>{children}</div>
  );
}

/** hero 那一格的统一形状：本机曲目和 Apple Music 条目共用同一套渲染 */
type Hero = {
  key: string;
  artwork: string | null;
  title: string;
  subtitle: string;
  link: string | null;
  label: string;
  playing: boolean;
  /** 封面取色。实时曲目没有自己的，能对上最近播放里同一张就借用。 */
  palette: string[];
  /** 整张专辑 / 歌单的总时长。实时那一支不用（它显示的是曲目进度） */
  durationMs: number | null;
  /**
   * 本机 Music.app 正在放的那首（而不是 Apple Music 的历史记录）。
   * 有值就说明能拿到播放进度，副标题行会换成带进度条的版本。
   *
   * 没有它就是历史那一版：`playing` 恒为假 —— 「在不在播」只认设备实况，
   * 最近播放列表说明不了这件事。
   */
  track: LocalNowPlaying | null;
};

export function ListeningCard({
  fallback,
  nowFallback,
  lyricsFallback,
  artworkPlaceholders,
  className,
  wide = false,
}: {
  fallback: StatusResponse<ListeningPayload>;
  nowFallback: StatusResponse<NowListeningPayload>;
  /**
   * 首屏当前曲目的同步歌词数据，由服务端在直读 SQLite 缓存后冻进首屏 HTML。
   */
  lyricsFallback?: LyricsFallback | null;
  /**
   * 首屏那批封面的低清占位（模板 URL → data URI），见 lib/artwork-placeholder。
   * 只喂给 `next/image` 的 `placeholder`，`src` 仍是 Apple CDN 直连；挂载后
   * 换进来的新歌不在表里，那一格就没有占位 —— 和内联之前一样，属预期。
   */
  artworkPlaceholders: ArtworkPlaceholders;
  className?: string;
  /** 充电卡隐藏、桌面端横跨两列时，列表切成 4 × 2 的无滚动布局。 */
  wide?: boolean;
}) {
  // 有东西可显示就走松的那档，空着就快一点，见上面两个常量
  const { data, error, isLoading } = useStatus<ListeningPayload>(
    LISTENING_PATH,
    (current) => (current ? REFRESH_MS : EMPTY_REFRESH_MS),
    { fallback },
  );
  useLiveEvents();
  const player = useWebPlayer();
  const { data: live } = useStatus<NowListeningPayload>(NOW_LISTENING_PATH, MUSIC_REFRESH_MS, {
    fallback: nowFallback,
  });
  /**
   * 暂停宽限期到点时再问一次。
   *
   * 那一刻服务端会把来源让给下一个实时源，但它不对应任何一次上报，没有推送
   * 会到 —— 从前是服务端挂 setTimeout 补一条，serverless 上不成立。剩多少毫秒
   * 由服务端算好放在 expiresInMs 里，这边只管排队，不重算规则、也不拿本机时钟
   * 去减设备时钟。
   */
  useExpiryRefetch(NOW_LISTENING_PATH, live?.expiresInMs);

  const reduced = useReducedMotion();

  // MacBook 与 HomePod 都没有可用状态时才退回最近播放列表。
  const localMusic = live?.idle ? null : live?.music ?? null;
  const localTrack =
    localMusic?.title && localMusic.state !== "stopped" ? localMusic : null;
  // 来源仍然只由服务端选，前端不重算宽限期，只负责在它到期时再问一次
  // （见上面的 nowListeningInterval），所以这里渲染的始终是服务端的结论。
  const localActive = Boolean(localTrack);

  /**
   * 闩住这首歌的目录解析结果。
   *
   * songId 是服务端拿曲名现查目录得来的，而那条链路（凭据、Storage、Apple 上游）
   * 任何一环抖一下，songId 就会在**歌照播**的情况下丢半分钟 —— 跟听把它当成
   * 「主人停了」，先暂停、解析恢复再播放，就是切歌边界那种一停一播的来源。
   * 同一首还在播就沿用上一次解析出的 songId / 预排队列；换歌后新曲还没解析
   * 出来时不沿用 —— 那是别的歌，宁可等。
   *
   * link 和 songId 出自同一次目录查询，一起抖、一起丢，所以也得一起闩住：
   * 动态封面按 hero.link 取，link 一空 videoUrl 就空，<video> 直接卸掉、
   * 解析恢复再从头挂一个 —— 看起来就是封面播着播着定住一会、又从头播。
   */
  // 专辑也进键：录音室版和现场版同名同艺人，闩住上一首的 songId 会让跟听和歌词
  // 在新曲解析出来之前先按旧录音走一截
  const trackKey = localTrack
    ? `${localTrack.title ?? ""}|${localTrack.artist ?? ""}|${localTrack.album ?? ""}`
    : null;
  const [lookupLatch, setLookupLatch] = useState<{
    key: string;
    songId: string;
    link: string | null;
    upcomingSongIds: string[];
    hasLyrics: boolean;
  } | null>(null);
  // 渲染期直接调整，不放 useEffect —— 那样要多渲染一轮，而且 set-state-in-effect
  // 本来就是反模式。React 对「props 变了顺手修 state」推荐的就是这个写法。
  if (
    live?.songId &&
    trackKey &&
    (lookupLatch?.key !== trackKey || lookupLatch.songId !== live.songId)
  ) {
    setLookupLatch({
      key: trackKey,
      songId: live.songId,
      link: live.link,
      upcomingSongIds: live.upcomingSongIds,
      hasLyrics: live.hasLyrics,
    });
  }
  const latched = trackKey && lookupLatch?.key === trackKey ? lookupLatch : null;
  const resolvedSongId = live?.songId ?? latched?.songId ?? null;
  const resolvedUpcoming = live?.songId ? live.upcomingSongIds : latched?.upcomingSongIds ?? [];
  const resolvedHasLyrics = live?.songId ? live.hasLyrics : latched?.hasLyrics ?? false;

  // 同步歌词跟着闩住的那个 songId 走，和跟听同一份；目录说没有就不发请求
  const { lyrics, songwriters, isLoading: lyricsLoading } = useLyrics(
    resolvedSongId,
    resolvedHasLyrics,
    lyricsFallback,
  );

  /**
   * 宽屏且处于实时播放中时，若曲目包含歌词（已载入或正在载入），在右半侧开辟独立
   * 歌词区域；窄屏或没有歌词时维持单列排布。
   */
  const showSideLyrics = Boolean(
    wide &&
      localActive &&
      (Boolean(lyrics && lyrics.length > 0) || (lyricsLoading && resolvedHasLyrics)),
  );

  /**
   * 移动端独立歌词区域：在移动端曲目有歌词时另起一行展示。
   * 切歌期间若新曲目目录信息尚在解析中（resolvedSongId 为空），保持展示骨架屏，
   * 避免因短暂未判定是否有歌词而导致卡片高度反复收缩和弹跳。
   */
  const isResolvingTrack = localActive && resolvedSongId == null;
  const showMobileLyrics = Boolean(
    localActive &&
      (Boolean(lyrics && lyrics.length > 0) ||
        (lyricsLoading && resolvedHasLyrics) ||
        isResolvingTrack),
  );

  /**
   * 跟着这首一起听。访客用自己的订阅授权，音频不经过站点，见 use-listen-along。
   *
   * 右上角那格平时写着「Apple Music」（说明这张卡的来源），有东西可跟听时换成
   * 按钮 —— 那一刻「你也能听」比「这是 Apple Music」更值得占这个位置。
   * 已经开始跟听之后一直留着，否则主人一停，访客就没地方把它关掉了。
   */
  const listenAlong = useListenAlong({
    track: localTrack,
    songId: resolvedSongId,
    upcomingSongIds: resolvedUpcoming,
  });

  /**
   * 网页播放器和「一起听」驱动的是同一个 MusicKit 单例，两边只能活一个。
   *
   * 交接必须发生在**动手之前**、在同一个点击里：跟听的 stop() 是把 music 置
   * null，真正的 music.stop() 在那个 effect 的清理里跑，落在这次提交之后 ——
   * 如果等播放器 active 了再去停跟听，那一记 stop() 会砸在刚装好的队列上，
   * 专辑刚响就哑。反过来同理：先叫播放器停，再让跟听去 getMusicKit。
   *
   * 不可播的条目（没有目录链接）不进播放器，保留原来跳 Apple Music 的行为。
   */
  const stopListenAlong = listenAlong.stop;
  const openInPlayer = useCallback(
    (item: ListeningItem) => {
      if (!player) return;
      stopListenAlong();
      player.openWith(item);
    },
    [player, stopListenAlong],
  );
  const canOpenInPlayer = (item: ListeningItem) =>
    Boolean(player && player.status !== "unavailable" && queueOptionsFor(item));
  const mutualListenAlong = useMemo(
    () => ({
      ...listenAlong,
      start: () => {
        player?.stop();
        listenAlong.start();
      },
    }),
    [listenAlong, player],
  );

  const showListenAlong =
    listenAlong.status !== "unavailable" &&
    (Boolean(localTrack && resolvedSongId) || listenAlong.status !== "idle");

  const [latest, ...tail] = data?.items ?? [];

  const hero: Hero | null = localActive
    ? {
        key: `${localTrack!.source}:${localTrack!.trackId ?? localTrack!.title}`,
        artwork: localTrack!.artworkUrl,
        title: localTrack!.title ?? "",
        // 只放艺人：标题已经是曲名，专辑名多半是「曲名 - Single」这种同义重复
        subtitle: localTrack!.artist ?? "",
        // 设备给不出可分享的地址，服务端拿曲名 + 艺人去目录里解析出来的；
        // 解析抖掉的那半分钟沿用闩住的那条，动态封面才不会跟着拆一次
        link: live?.link ?? latched?.link ?? null,
        label:
          localTrack!.state === "playing"
            ? localTrack!.repeatOne
              ? "单曲循环"
              : "正在播放"
            : "播放暂停",
        playing: localTrack!.state === "playing",
        palette:
          data?.items.find((item) => item.id === live?.id)?.palette ?? [],
        durationMs: null,
        track: localTrack,
      }
    : latest
      ? {
          key: latest.id,
          artwork: latest.artwork,
          title: latest.title,
          subtitle: latest.artist,
          link: latest.link,
          // 没有实况就只说「听过」。Apple 不给可查的当前播放，站点也不再拿列表
          // 的变化去猜它，理由见 lib/apple-music-recent
          label: "最近听过",
          playing: false,
          palette: latest.palette,
          durationMs: latest.durationMs,
          track: null,
        }
      : null;

  // 本机那首顶替 hero 时，Apple Music 原来的第一首下沉回列表；
  // 但和实时资源 ID 相同的条目不再重复展示。
  const rest = dedupeListeningItems(
    localActive ? (data?.items ?? []) : tail,
    localActive ? (live?.id ?? null) : null,
  );
  // 对重排稳定的 key，否则顶部插入新条目时会被当成整批换新
  const restKeys = stableKeys(rest.map((item) => item.id));
  /**
   * 能进播放器的那几张封面，按弹窗和缩略图的尺寸提前拉好（见 PlayerArtworkPreload）：
   * 点开卡片时封面得已经在那儿，而不是再等一次加载。同一张封面出现多次
   * （hero 和列表）只算一次。
   */
  const preloadArtworks = Array.from(
    new Set(
      [latest, ...rest].flatMap((entry) =>
        entry?.artwork && canOpenInPlayer(entry) ? [entry.artwork] : [],
      ),
    ),
  );
  const listRef = useRowSnap(restKeys[0], wide);

  /**
   * 半宽横滑是 CSS scroll-snap。增删条目时 popLayout 会把离场行改成绝对定位，
   * 吸附目标跟着飞 —— 和「最近在看 / 最近在玩」同一套：动画窗口里先摘掉吸附。
   */
  const ids = restKeys.join("\n");
  const [snappedIds, setSnappedIds] = useState(ids);
  const [reflowing, setReflowing] = useState(false);
  if (snappedIds !== ids) {
    setSnappedIds(ids);
    setReflowing(true);
  }
  useEffect(() => {
    if (!reflowing) return;
    const timer = setTimeout(() => setReflowing(false), UNSNAP_MS);
    return () => clearTimeout(timer);
  }, [reflowing, ids]);

  const { data: motionData } = useMotionArtwork(hero?.link);
  // 动态封面自带一套取色，比静态封面那套晚到；交给 PaletteBar 淡进来，别直接顶掉
  const motionGradient =
    motionData?.colors && motionData.colors.length >= 2
      ? paletteGradient(motionData.colors)
      : undefined;

  return (
    <Card
      label="Recently Played"
      action={showListenAlong ? <ListenAlongButton listen={mutualListenAlong} /> : "Apple Music"}
      className={cn("h-full min-h-93.5", className)}
    >
      <div className="flex min-h-0 flex-1 flex-col px-4 pb-4 pt-3">
        {/* 最近的一项放大展示。整块都是链接 —— 点封面也能跳转。
            换专辑/歌单时新旧叠着交叉淡入，见 HERO_VARIANTS。

            外层 h-20 钉死高度：封面是 w-20 方块，整块 hero 设计上就是 80px。
            子项一律 absolute inset-0 —— 新旧叠在同一个槽里淡入淡出，不挤文档流，
            也就不需要 popLayout（它和 overflow / 固定高度容器打架，动画会被吃掉）。

            首屏「读取中」不进 AnimatePresence：占位态和 hero 根本不是同一个东西，
            让它们互相淡入淡出没有意义，只会在数据到达时糊一下。等有数据再挂载，
            initial={false} 就会直接跳过入场动画，首屏不播这一下。 */}
        <div className="relative h-20 shrink-0">
          {!hero ? (
            <HeroWrapper link={null}>
              <div className="relative aspect-square w-20 shrink-0 overflow-hidden rounded-md border border-line bg-muted" />
              <div className="flex min-w-0 flex-1 flex-col justify-center">
                <div className="text-sm text-muted-foreground">
                  {isLoading
                    ? "读取中…"
                    : error
                      ? "Apple Music 未连接"
                      : "最近没有播放记录"}
                </div>
              </div>
            </HeroWrapper>
          ) : (
            <AnimatePresence initial={false}>
              <motion.div
                key={hero.key}
                className="absolute inset-0"
                variants={reduced ? STATIC_VARIANTS : HERO_VARIANTS}
                initial="initial"
                animate="animate"
                exit="exit"
                // 非对称时长写在 variant 里，这里传统一的 transition 会把它抹平
                transition={reduced ? STATIC_TRANSITION : undefined}
              >
                <HeroWrapper
                  link={hero.link}
                  wideLyrics={showSideLyrics}
                  // 只有历史那一版 hero 进播放器；本机正在放的那首已经有「一起听」
                  onOpen={
                    !hero.track && latest && canOpenInPlayer(latest)
                      ? () => openInPlayer(latest)
                      : undefined
                  }
                >
                  <div className={cn("flex min-w-0 flex-1 gap-3", showSideLyrics && "md:pr-5")}>
                    <HeroMotionArtwork
                      artwork={hero.artwork}
                      placeholder={
                        hero.artwork ? artworkPlaceholders.hero[hero.artwork] : undefined
                      }
                      title={hero.title}
                      videoUrl={motionData?.hasMotion ? motionData.videoUrl : null}
                      reduced={Boolean(reduced)}
                    />

                    {/*
                  不用统一的 gap：三行的行内 leading 不一样（标签行盒高贴合文字，
                  标题和副标题各自还有 3px 内部余白），统一 gap 会让视觉间隙一宽一窄。
                  这里按实测的 leading 差额补偿，让两处视觉间隙都落在 8px 左右。
                */}
                    <div className="flex min-w-0 flex-1 flex-col justify-center overflow-hidden">
                      {/* 图标在左、文字在右，和 CHARGER / C1 那些标签行一致：
                          对齐的是图标的左边界，标签文字本身缩进。

                          min-h-5 锁死行高：设备标签只在实时曲目那一版出现，它自带
                          边框和内距（20px），比光秃秃的 label-mono（约 12px）高一截。
                          不锁的话两版 hero 高度不同，外层 justify-center 会重新居中，
                          切换时整列上下挪一下 —— 交叉淡入让新旧同时可见，那一挪就成了
                          肉眼可见的滑动。 */}
                      <div className="flex min-h-5 min-w-0 items-center gap-1.5">
                        {/* 有 track 就是实时源：没在放就是暂停，冻住而不是弹回固定形状 */}
                        <Bars
                          state={
                            hero.playing ? "playing" : hero.track ? "paused" : "idle"
                          }
                        />
                        <span
                          className={cn(
                            "label-mono shrink-0",
                            hero.playing ? "text-live" : "text-muted-foreground",
                          )}
                        >
                          {hero.label}
                        </span>
                        {/* 实时曲目来自 MacBook Music.app 或 HomePod，不是历史记录。 */}
                        {hero.track && (
                          <span className="ml-0.5 inline-flex min-w-0 items-center gap-1 rounded-sm border border-line px-1.5 py-px text-[10px] leading-4 text-muted-foreground">
                            {hero.track.source === "homepod" ? (
                              <HomePodMiniIcon className="size-3 shrink-0" aria-hidden />
                            ) : (
                              <MacBookProIcon className="size-3 shrink-0" aria-hidden />
                            )}
                            <span className="truncate">
                              {hero.track.source === "homepod" ? "HomePod mini" : "MacBook Pro"}
                            </span>
                          </span>
                        )}
                      </div>
                      <div
                        className={cn(
                          "mt-1 truncate font-medium leading-snug",
                          hero.link && "group-hover:underline",
                        )}
                        title={hero.title}
                      >
                        {hero.title}
                      </div>
                      {hero.track ? (
                        <HeroProgress
                          track={hero.track}
                          subtitle={hero.subtitle}
                          palette={hero.palette}
                          motionGradient={motionGradient}
                          lyrics={lyrics}
                          sideLyrics={showSideLyrics}
                        />
                      ) : (
                        <>
                          {/* 和实时那版的副标题行同构：左边艺人，右边时间。那边是
                              「已播 / 总长」，这边没有进度，只放总长。 */}
                          <div className="mt-px flex items-baseline gap-2 text-sm text-muted-foreground">
                            <span className="min-w-0 flex-1 truncate" title={hero.subtitle}>
                              {hero.subtitle}
                            </span>
                            {hero.durationMs != null && (
                              <span className="label-mono shrink-0 tabular-nums">
                                {formatDuration(hero.durationMs)}
                              </span>
                            )}
                          </div>
                          {/* 尺寸和 HeroProgress 那根进度条一模一样。历史条目没有进度可
                              显示，但两版 hero 的高度必须一致，理由同上面那段 —— 与其留
                              一道不可见的空档，不如填满，见 globals.css 的 .rainbow-bar。 */}
                          <PaletteBar
                            className="mt-1.5 h-0.75"
                            base={paletteGradient(hero.palette)}
                            motion={motionGradient}
                            // 取不到调色板时露出 .rainbow-bar 自带的那条通用彩虹
                            idleClassName="rainbow-bar"
                          />
                        </>
                      )}
                    </div>
                  </div>

                  {showSideLyrics && (
                    <div className="hidden min-w-0 border-l border-line pl-5 md:flex md:flex-col md:justify-center overflow-hidden">
                      {lyrics ? (
                        <HeroLyrics
                          lyrics={lyrics}
                          track={hero.track!}
                          songwriters={songwriters}
                          reduced={Boolean(reduced)}
                        />
                      ) : (
                        <HeroLyricsSkeleton />
                      )}
                    </div>
                  )}
                </HeroWrapper>
              </motion.div>
            </AnimatePresence>
          )}
        </div>

        {/* 移动端独立三行滚动歌词区域：位于播放器下方，切歌时与上方播放器解耦，
            高度固定为 80px，彻底消除切歌时卡片高度上下弹跳抖动 */}
        <AnimatePresence initial={false}>
          {showMobileLyrics && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={
                reduced
                  ? { duration: 0 }
                  : { duration: 0.25, ease: "easeInOut" }
              }
              className="overflow-hidden md:hidden"
            >
              <div className="mt-3 min-w-0 border-t border-line/60 pt-2.5">
                {lyrics && hero?.track ? (
                  <HeroLyrics
                    lyrics={lyrics}
                    track={hero.track}
                    songwriters={songwriters}
                    reduced={Boolean(reduced)}
                  />
                ) : (
                  <HeroLyricsSkeleton />
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/*
          再往前的几项。上游最多给 10 条。窄屏和桌面半宽横滑两页、宽态 4×2，
          都只展示 8 条。

          视口必须始终挂着：列表为空时 isLoading 也是 false、rest 也是空的 ——
          以前用 (isLoading || rest.length) 包一层，那种情况下首屏 HTML 就把
          这块省掉了，客户端补上数据再插进来，整行一起被撑高。

          高度用 minHeight 而不是写死：充电头那边 sparkline 钉在 h-32，
          整行由它定高；这边列表吃掉剩余，行高由 grid-auto-rows 平摊。
        */}
        {/* 边框和内边距放在外层，滚动容器本身不带 padding ——
            否则吸附位会被 padding 顶偏，还得再补 scroll-padding
            min-h-0 不能少：flex 子项默认 min-height:auto，会被内容撑破而不是滚动 */}
        <div className="mt-3 flex min-h-0 flex-1 flex-col border-t border-line pt-2">
          {/*
            滚动容器绝对定位，是为了让它对「这张卡有多高」完全没有发言权。
            grid 行按 max-content 定高：让它参与的话，10 条 × 行高会被当成
            卡片的固有高度，整个「此刻」区块被撑到近两倍（实测 364 → 588）。
            绝对定位的子元素不参与固有尺寸计算；min-height 是这块唯一的话语权。
          */}
          <div
            className="relative min-h-0 flex-1"
            style={
              {
                minHeight: `${MIN_ROW_HEIGHT_PX * VISIBLE_ROWS}px`,
                "--recent-track-rows": VISIBLE_ROWS,
              } as CSSProperties
            }
          >
            <div
              ref={listRef}
              // 独立滚动区：给它名字和角色，键盘也能直接聚上来用方向键滚
              // （Firefox / 部分 Safari 不会让没有 tabindex 的滚动容器获得焦点）
              tabIndex={0}
              role="region"
              aria-label="最近播放"
              className={cn(
                "absolute inset-0",
                "recent-tracks",
                wide && "is-wide",
                reflowing && "is-reflowing",
                "scroll-smooth",
                // 关掉滚动锚定：新条目插到顶部时，浏览器会为了「保持视觉位置不动」
                // 自动把 scrollTop 加一行，结果第一行被顶出可视区，得手动滑回去
                "[overflow-anchor:none]",
                "scrollbar-none [&::-webkit-scrollbar]:hidden",
              )}
            >
              {/*
                网格在这一层、不在滚动盒上：半宽要按列往右排成两页，滚动盒
                自己当网格的话多出来的列没有独立的含块，scrollWidth 对不齐。
                relative 留给 popLayout 的离场行，让它们留在轨道里而不是钉在视口上。
              */}
              <div className="recent-tracks-track">
                {rest.length > 0 ? (
                  // popLayout 让离场的行脱离布局流，剩下的能同时补位而不是等它消失
                  <AnimatePresence initial={false} mode="popLayout">
                    {rest.map((item, index) => (
                      <motion.div
                        key={restKeys[index]}
                        layout={!reduced}
                        variants={reduced ? STATIC_VARIANTS : LIST_ITEM_VARIANTS}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        transition={reduced ? STATIC_TRANSITION : LIST_TRANSITION}
                        // 高度由 grid 轨道给；min-w-0 保住行内的 truncate
                        // 每页第一行吸附：宽态桌面 overflow:hidden，这条不会生效
                        className={cn("min-w-0", index % VISIBLE_ROWS === 0 && "snap-start")}
                      >
                        <TrackRow
                          track={item}
                          placeholder={
                            item.artwork
                              ? artworkPlaceholders.rows[item.artwork]
                              : undefined
                          }
                          onOpen={canOpenInPlayer(item) ? () => openInPlayer(item) : undefined}
                        />
                      </motion.div>
                    ))}
                  </AnimatePresence>
                ) : isLoading ? (
                  Array.from({ length: VISIBLE_ROWS }, (_, i) => (
                    <SkeletonRow key={i} />
                  ))
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
      <PlayerArtworkPreload artworks={preloadArtworks} />
    </Card>
  );
}
