"use client";

import { EyeOff } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import Image from "next/image";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import useSWR, { preload, useSWRConfig } from "swr";

import { TrophyMetal } from "@/components/trophies/trophy-metal";
import { backendUrl } from "@/lib/backend-url";
import { LIST_TRANSITION, STATIC_TRANSITION } from "@/lib/motion";
import {
} from "@/lib/playstation-image";
import { trophiesTilePath } from "@/lib/paths";
import { site } from "@/lib/site";
import type { StatusResponse, TrophiesPayload, Trophy, TrophyTitle } from "@/lib/types";
import { cn } from "@/lib/utils";

const CATALOG_REFRESH_MS = 10 * 60_000;

/** 和 Recently Played 那列同一套：五行填满、停滚后吸到整行。 */
const VISIBLE_ROWS = 5;
const MIN_ROW_HEIGHT_PX = 56;
const SETTLE_DELAY_MS = 110;
const SUSPEND_AFTER_CHANGE_MS = 500;

/** 跳过来的那一行闪一下的时长，和 animate-trophy-focus 那条动画一样长。 */
const FLASH_MS = 1000;

/**
 * 一行奖杯的身份。首页提要里的「最近解锁」也拿它拼跳转目标，所以拼法
 * 只能有一处 —— 两边各拼一遍，哪天多带一段就会静默地对不上。
 */
export function trophyRowKey(
  npCommunicationId: string,
  groupId: string,
  id: number,
): string {
  return `${npCommunicationId}-${groupId}-${id}`;
}

/**
 * 列宽跟游戏瓷砖同一套公式（见 playstation-card TILE_TRACK）：
 * 默认 1 列、md 2、lg 3；减掉的是 gap-3。
 * 只有两组时到 md 就并排、不在 lg 上空出第三列；窄屏仍旧跟着一列走，
 * 不把两张卡挤成半宽。
 */
function groupTrack(count: number) {
  return cn(
    "grid grid-flow-col grid-rows-1 gap-3",
    count <= 2
      ? ["auto-cols-[100%]", "md:auto-cols-[calc((100%-0.75rem)/2)]"]
      : [
          "auto-cols-[100%]",
          "md:auto-cols-[calc((100%-0.75rem)/2)]",
          "lg:auto-cols-[calc((100%-1.5rem)/3)]",
        ],
  );
}

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

function formatStamp(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", {
    timeZone: site.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function trophyDetail(trophy: Trophy): string | null {
  if (trophy.hidden && !trophy.earned) return "解锁后显示";
  return trophy.detail;
}

function rarityLabel(rate: number): string {
  if (rate < 5) return "极稀有";
  if (rate < 15) return "非常稀有";
  if (rate < 50) return "稀有";
  return "常见";
}

/** 全球持有率。不到 0.1% 的不能收成 0%，极稀有和「没人拿」不是一回事。 */
function formatEarnedRate(rate: number): string {
  const clamped = Math.min(100, Math.max(0, rate));
  const tenths = Math.round(clamped * 10) / 10;
  if (clamped > 0 && tenths === 0) return "<0.1%";
  return `${Number.isInteger(tenths) ? String(tenths) : tenths.toFixed(1)}%`;
}

async function fetchCatalog(path: string): Promise<StatusResponse<TrophiesPayload>> {
  const response = await fetch(backendUrl(path), { cache: "no-store" });
  if (!response.ok) throw new Error(`请求 ${path} 失败：${response.status}`);
  return response.json();
}

/**
 * 悬停 / 聚焦就先把这块瓷砖的目录取回来，别等点击。
 *
 * 面板展开动画本身就有 LIST_DURATION（320ms），而这一份切片一般几百毫秒内
 * 就回来了 —— 提前这一步，展开时数据多半已经在缓存里，面板一开就是奖杯，
 * 连骨架都不必露面。缓存命中过的瓷砖不重复取：`preload`
 * 的那份预取记录会在 `useSWR` 消费掉之后清空，不拦一下的话，鼠标扫过一排
 * 打开过的瓷砖就是一排重复请求。
 */
export function useTrophyPrefetch() {
  const { cache } = useSWRConfig();
  return useCallback(
    (titleIds: string[]) => {
      const key = trophiesTilePath(titleIds);
      if (cache.get(key)?.data) return;
      // 预取失败不声张：点开时 useSWR 会自己再问一次，那次才有加载态和报错
      preload(key, fetchCatalog).catch(() => {});
    },
    [cache],
  );
}

/**
 * 点开瓷砖才拉奖杯明细，不进首屏 HTML；拉的也只是这块瓷砖对上的那 1–2 款
 * （服务端按 titleIds 切，键就是切片本身，见 lib/paths 的 trophiesTilePath）。
 * 每块打开过的瓷砖各占一个键，关掉面板 SWR 仍留着那份缓存。
 *
 * `null` 表示当前没有展开的瓷砖，不取数。
 *
 * 从前整份目录只有一个键，可以开 keepPreviousData；现在键跟着展开的瓷砖走，
 * 开着就是在 B 的面板里摆着 A 的奖杯，直到 B 那次请求回来 —— 宁可显示加载态。
 */
export function useTrophyCatalog(titleIds: string[] | null) {
  const key = titleIds ? trophiesTilePath(titleIds) : null;
  const { data, error, isLoading } = useSWR<StatusResponse<TrophiesPayload>>(
    key,
    fetchCatalog,
    {
      refreshInterval: key ? CATALOG_REFRESH_MS : 0,
      shouldRetryOnError: false,
      /*
       * 开合一次就重问一遍太吵：目录只在解锁新杯子时才变，而面板开着的时候
       * 上面那条 10 分钟轮询已经在盯了。一分钟内的反复开合去重掉，比这更久
       * 的再问一次 —— 关着的时候没有轮询，那段时间的解锁得靠这一次带回来。
       * 留在轮询间隔之内，两者不会互相吃掉。
       */
      dedupingInterval: 60_000,
    },
  );
  return {
    titles: data?.ok ? data.data.titles : undefined,
    error: data && !data.ok ? data.error : error ? String(error.message ?? error) : undefined,
    isLoading,
  };
}

/**
 * 保证列表永远停在整行上。理由和实现照搬 Recently Played：不用 CSS
 * scroll-snap，只在用户停滚之后对齐到最近的整行。
 */
function useRowSnap(topKey: string | undefined) {
  const node = useRef<HTMLDivElement | null>(null);
  const previous = useRef(topKey);
  const suspendUntil = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useIsomorphicLayoutEffect(() => {
    if (previous.current === topKey) return;
    previous.current = topKey;
    suspendUntil.current = Date.now() + SUSPEND_AFTER_CHANGE_MS;

    const el = node.current;
    if (!el || el.scrollTop === 0) return;
    const saved = el.style.scrollBehavior;
    el.style.scrollBehavior = "auto";
    el.scrollTop = 0;
    el.style.scrollBehavior = saved;
  }, [topKey]);

  return useCallback((el: HTMLDivElement | null) => {
    node.current = el;
    if (!el) return;

    const onScroll = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        if (Date.now() < suspendUntil.current) return;
        const rowHeight = el.clientHeight / VISIBLE_ROWS;
        const target = Math.round(el.scrollTop / rowHeight) * rowHeight;
        if (Math.abs(target - el.scrollTop) < 0.5) return;
        el.scrollTo({ top: target, behavior: "smooth" });
      }, SETTLE_DELAY_MS);
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (timer.current) clearTimeout(timer.current);
      node.current = null;
    };
  }, []);
}

/**
 * 奖杯图那两格的边长：明细里是 size-11（44px），组条那格宽 w-10 但高度跟着
 * 行走、也在 44 上下。两处同一个数，取图时按它乘 3 倍。
 */
const ICON_PX = 44;

function TrophyRow({ trophy }: { trophy: Trophy }) {
  const hidden = trophy.hidden && !trophy.earned;
  const locked = !trophy.earned;
  const subtitle =
    trophyDetail(trophy) ??
    (trophy.earned && trophy.earnedAt ? formatStamp(trophy.earnedAt) : "未解锁");
  const rate = trophy.earnedRate;
  const fill = rate == null ? null : Math.min(100, Math.max(0, rate));
  return (
    <div className="relative flex h-full items-center overflow-hidden rounded-md transition-colors hover:bg-surface-hover">
      {/*
       * 全球持有率的条就是行底那道半透明阴影，宽 = 百分比。
       * 不用 --live：那是实时数据的颜色。半透明才能让 hover 底色透出来。
       */}
      {fill != null ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 bg-foreground/8"
          style={{ width: `${fill}%` }}
        />
      ) : null}
      <div className="relative flex h-full min-w-0 flex-1 items-center gap-2.5 px-2">
        <div
          className={cn(
            "relative size-11 shrink-0 overflow-hidden rounded-sm border border-line bg-muted",
            locked && !hidden && "grayscale",
            hidden && "border-dashed",
          )}
        >
          {trophy.iconUrl && !hidden ? (
            <Image
              // 尺寸在 PSN 那边就选好，不进图片管道；理由见 playstation-image
              src={trophy.iconUrl}
              alt=""
              fill
              unoptimized
              className={cn("object-cover", locked && "opacity-55")}
            />
          ) : (
            <div className="grid h-full place-items-center text-muted-foreground">
              {hidden ? (
                <EyeOff className="size-4" strokeWidth={1.75} />
              ) : (
                <TrophyMetal kind={trophy.type} size="sm" />
              )}
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <TrophyMetal
              kind={trophy.type}
              size="sm"
              className={cn(locked && "grayscale opacity-55")}
            />
            <span
              className={cn("min-w-0 truncate text-sm", locked && "text-muted-foreground")}
              title={hidden ? "隐藏奖杯" : trophy.name}
            >
              {hidden ? "隐藏奖杯" : trophy.name}
            </span>
            {/* 未解锁只靠灰阶和半透明表达，读屏取不到，补一句文本 */}
            {locked ? <span className="sr-only">未解锁</span> : null}
          </div>
          <div className="truncate text-xs text-muted-foreground" title={subtitle}>
            {subtitle}
          </div>
        </div>
        {rate != null ? (
          <span className="shrink-0 text-muted-foreground">
            <span className="text-xs">{rarityLabel(rate)}</span>
            <span className="text-xs"> · </span>
            <span className="label-mono">
              <span className="sr-only">全球玩家完成率 </span>
              {formatEarnedRate(rate)}
            </span>
          </span>
        ) : null}
      </div>
    </div>
  );
}

function GroupSlot({
  groups,
  resetKey,
}: {
  groups: { key: string; group: TrophyTitle["groups"][number] }[];
  resetKey: string | undefined;
}) {
  const reduced = useReducedMotion();
  const open = groups.length > 0;
  /*
   * 收起时 groups 已经空了，可退场动画还要跑一段 —— 留住最后一份非空的，
   * 组条才不会在收起过程中先闪成空白。
   *
   * 渲染期比较、渲染期更新（React 认可的 previous-value 写法）：条件为真时
   * setState 让这次渲染当场重来一遍，产出的还是同一棵树，提交出去的和从前
   * 用 ref 记那版逐字一致。
   */
  const [shown, setShown] = useState(groups);
  if (open && shown !== groups) setShown(groups);

  return (
    <motion.div
      data-trophy-groups-wrap=""
      initial={false}
      animate={{ height: open ? "auto" : 0, opacity: open ? 1 : 0 }}
      transition={reduced ? STATIC_TRANSITION : LIST_TRANSITION}
      className="overflow-hidden"
    >
      {shown.length ? (
        // 收起时高度是 0 但节点还在：光 aria-hidden 挡不住 tab 键，焦点还是能
        // 落进这条看不见的横滚区。inert 一次把 tab 序和读屏都摘掉。
        <div data-trophy-groups="" className="pb-2" inert={!open}>
          <GroupStrip groups={shown} resetKey={resetKey} />
        </div>
      ) : null}
    </motion.div>
  );
}

function GroupStrip({
  groups,
  resetKey,
}: {
  groups: { key: string; group: TrophyTitle["groups"][number] }[];
  resetKey: string | undefined;
}) {
  const node = useRef<HTMLDivElement | null>(null);
  const previous = useRef(resetKey);

  useIsomorphicLayoutEffect(() => {
    if (previous.current === resetKey) return;
    previous.current = resetKey;
    const el = node.current;
    if (!el || el.scrollLeft === 0) return;
    const saved = el.style.scrollBehavior;
    el.style.scrollBehavior = "auto";
    el.scrollLeft = 0;
    el.style.scrollBehavior = saved;
  }, [resetKey]);

  return (
    <div
      ref={node}
      tabIndex={0}
      role="region"
      aria-label="奖杯组"
      className={cn(
        "scroll-smooth overflow-x-auto overscroll-x-contain",
        "snap-x snap-mandatory",
        "scrollbar-none [&::-webkit-scrollbar]:hidden",
      )}
    >
      <div className={groupTrack(groups.length)}>
        {groups.map(({ key, group }) => (
          <div key={key} className="min-w-0 snap-start">
            <div className="flex items-stretch overflow-hidden border border-line bg-surface">
              {group.iconUrl ? (
                <div className="relative w-10 shrink-0 self-stretch overflow-hidden border-r border-line bg-muted">
                  <Image
                    // 组条那格 w-10 但高度跟着行走（约 44px），object-cover
                    // 以高的那边为准，所以按 ICON_PX 取，不按 40 取
                    src={group.iconUrl}
                    alt=""
                    fill
                    unoptimized
                    className="object-cover"
                  />
                </div>
              ) : null}
              <div className="min-w-0 flex-1 px-2 py-1.5">
                <div className="truncate text-xs font-medium">{group.name}</div>
                <div className="label-mono text-muted-foreground">{group.progress}%</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TrophyViewport({
  listRef,
  children,
}: {
  listRef?: (el: HTMLDivElement | null) => void;
  children: ReactNode;
}) {
  return (
    <div className="relative" style={{ height: MIN_ROW_HEIGHT_PX * VISIBLE_ROWS }}>
      <div
        ref={listRef}
        tabIndex={0}
        role="region"
        aria-label="奖杯"
        className={cn(
          "absolute inset-0 grid overflow-y-auto",
          "scroll-smooth overscroll-y-contain [overflow-anchor:none]",
          "scrollbar-none [&::-webkit-scrollbar]:hidden",
        )}
        style={{ gridAutoRows: `calc(100% / ${VISIBLE_ROWS})` }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * 加载态。铺的是和真行同一套几何：同一个 TrophyViewport、同样的行高网格、
 * 图标那格也是 size-11 —— 目录回来时只是灰块换成内容，面板不跳、也不闪。
 *
 * 行数按摘要里那份杯数来（`rows`）：摘要没来就按满屏五行铺，宁可多铺也别
 * 少铺 —— 视口高度本来就是固定五行，少铺只会露出一截空白。
 */
function TrophySkeleton({ rows }: { rows: number }) {
  const count = Math.max(1, Math.min(rows, VISIBLE_ROWS));
  return (
    <TrophyViewport>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex h-full items-center gap-2.5 rounded-md px-2">
          <div className="size-11 shrink-0 animate-pulse rounded-sm bg-muted" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3 w-2/5 animate-pulse rounded bg-muted" />
            <div className="h-2.5 w-3/5 animate-pulse rounded bg-muted" />
          </div>
        </div>
      ))}
    </TrophyViewport>
  );
}

export function TrophyExpand({
  name,
  titles,
  loading,
  error,
  rows = VISIBLE_ROWS,
  knownEmpty = false,
  focusKey,
  onFocused,
}: {
  name: string;
  titles: TrophyTitle[] | undefined;
  loading: boolean;
  error?: string;
  /** 摘要里那款的杯数，只用来决定加载态铺几行；不知道就按满屏铺 */
  rows?: number;
  /**
   * 摘要**收到了**、里面这张卡就没有奖杯组，于是不必先铺 5 行再收。
   * 摘要本身没来（信封 !ok）时必须是 false —— 那是「不知道」，不是「没有」。
   */
  knownEmpty?: boolean;
  /** 要定位的那一行（trophyRowKey）。目录是异步拉的，所以等行真的在了才滚。 */
  focusKey?: string;
  /** 滚到了就喊一声：一次性语义由上面那层负责，这里不留着这个 key。 */
  onFocused?: () => void;
}) {
  const reduced = useReducedMotion();
  const trophies = titles?.flatMap((title) =>
    title.trophies.map((trophy) => ({
      key: trophyRowKey(title.npCommunicationId, trophy.groupId, trophy.id),
      trophy,
    })),
  );
  const groups =
    titles?.flatMap((title) =>
      title.groups.length > 1
        ? title.groups.map((group) => ({
            key: `${title.npCommunicationId}-${group.id}`,
            group,
          }))
        : [],
    ) ?? [];
  const snapRef = useRowSnap(trophies?.[0]?.key);
  const viewport = useRef<HTMLDivElement | null>(null);
  // 吸附那个回调 ref 只认元素不外传，定位要用同一个元素，所以并成一个
  const listRef = useCallback(
    (el: HTMLDivElement | null) => {
      viewport.current = el;
      const detach = snapRef(el);
      return () => {
        viewport.current = null;
        detach?.();
      };
    },
    [snapRef],
  );

  const [flashKey, setFlashKey] = useState<string | null>(null);
  // 下标是个数，行数组每次渲染都是新的 —— 用它当依赖，effect 才只在目录到位时跑
  const focusIndex = focusKey ? (trophies?.findIndex((row) => row.key === focusKey) ?? -1) : -1;

  useEffect(() => {
    const el = viewport.current;
    if (focusIndex < 0 || !el) return;
    /*
     * 只滚这个容器自己。对行 scrollIntoView 会把所有能滚的祖先一起带走，
     * 整页的落点是外面那层定的，这里再滚一次就打架了。
     *
     * 落点是可视区正中那一行（五行里的第三行）：行心对容器心，也就是往上让出
     * 两行。前两行和后两行会被 clamp 顶到两端，那种情况不强求居中。
     * 减出来的仍是行高的整数倍，和 useRowSnap 的吸附网格天然对齐 ——
     * 停滚后那一下是空操作，不会把落点再拽走。
     */
    const rowHeight = el.clientHeight / VISIBLE_ROWS;
    const centered = focusIndex * rowHeight - (el.clientHeight - rowHeight) / 2;
    const top = Math.min(Math.max(centered, 0), el.scrollHeight - el.clientHeight);
    const key = focusKey ?? null;
    /*
     * 快到了就闪：一起手就闪的话，行还在半路、滑到中间时动画早放完了；
     * 可等完全停稳又迟钝 —— smooth 的尾段 ease-out 最后几十像素拖得最久。
     * 所以差不到一行就算到，闪起来的同时让它滑完最后那一点。
     * 停滚 110ms 的落定口径留作兜底（clamp 顶到两端、或已在目标位时
     * smooth 一个事件都不发，起手那个定时器就是这种情况的到达信号）。
     * onFocused 也等到这一刻：提前调它会让父层清掉 focusKey、效果重跑，
     * 把还在等待的监听拆掉。
     */
    let settle: ReturnType<typeof setTimeout>;
    let done = false;
    const onScroll = () => {
      if (Math.abs(el.scrollTop - top) < rowHeight) return arrived();
      clearTimeout(settle);
      settle = setTimeout(arrived, SETTLE_DELAY_MS);
    };
    const arrived = () => {
      if (done) return;
      done = true;
      clearTimeout(settle);
      el.removeEventListener("scroll", onScroll);
      setFlashKey(key);
      onFocused?.();
    };
    if (!reduced) el.addEventListener("scroll", onScroll, { passive: true });
    el.scrollTo({ top, behavior: reduced ? "auto" : "smooth" });
    settle = setTimeout(arrived, reduced ? 0 : SETTLE_DELAY_MS);
    return () => {
      clearTimeout(settle);
      el.removeEventListener("scroll", onScroll);
    };
  }, [focusIndex, focusKey, onFocused, reduced]);

  useEffect(() => {
    if (!flashKey) return;
    const timer = setTimeout(() => setFlashKey(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashKey]);

  const empty = (
    <div className="text-sm leading-snug text-muted-foreground">
      {name} 还没有奖杯记录
    </div>
  );

  // 目录还没到，才轮到摘要和加载态说话
  if (!titles) {
    // 只有摘要确实说过「这张卡没有奖杯组」时，才敢不等目录就下结论
    if (knownEmpty) return empty;
    if (loading) {
      // 读屏拿不到灰块的意思，状态仍旧要说出口
      return (
        <div role="status" aria-label="正在读取奖杯">
          <TrophySkeleton rows={rows} />
        </div>
      );
    }
    if (error) {
      return <div className="text-sm leading-snug text-muted-foreground">{error}</div>;
    }
    return empty;
  }
  // 目录到了就以目录为准：摘要那份 digest 漏了这款也不算数
  if (!trophies?.length) return empty;

  return (
    <div {...(groups.length ? { "data-trophy-groups-wanted": "" } : {})}>
      <GroupSlot groups={groups} resetKey={trophies[0]?.key} />
      <TrophyViewport listRef={listRef}>
        {trophies.map((row) => (
          <div
            key={row.key}
            className={cn(
              "min-w-0 rounded-md",
              // 减少动态效果时全站的动画都被压成 0.01ms，闪不出来 —— 退成一记静态底色
              row.key === flashKey && (reduced ? "bg-surface-hover" : "animate-trophy-focus"),
            )}
          >
            <TrophyRow trophy={row.trophy} />
          </div>
        ))}
      </TrophyViewport>
    </div>
  );
}
