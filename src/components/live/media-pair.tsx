"use client";

import { motion, useReducedMotion } from "motion/react";
import { useCallback, useState } from "react";

import { ChargerCard } from "@/components/live/charger-card";
import { ListeningCard } from "@/components/live/listening-card";
import { PowerBankCard } from "@/components/live/powerbank-card";
import { StatusDot } from "@/components/ui/status-dot";
import type { LyricsFallback } from "@/hooks/use-lyrics";
import type { ArtworkPlaceholders } from "@/lib/artwork-placeholder";
import type {
  ChargerPayload,
  ListeningPayload,
  NowListeningPayload,
  PowerBankPayload,
  StatusResponse,
} from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * 这一格的高度权威，三种形态共用一个数：充电头独占、充电宝独占、两张上下平分。
 *
 * 高度只能定在这里，不能定在卡片里 —— 两张卡平分时各自只有一半高，谁都撑不住这
 * 一行；而这一行一矮，右边那张 inset-block:0 贴着它的最近播放就得重排下半部分。
 *
 * **写死高度，不用 min-h。** min-h 只是个下限：独占时整格由卡片内容撑出 374.5px，
 * 平分时两张精炼卡够不着下限、正好落在 374px —— 半个像素的差，每切一次就把右边
 * 那张列表推一下。写死之后三种形态量出来是同一个数，和内容无关。
 *
 * 取 396：两种形态的顶部（大数字 + 状态行）现在是同一套尺寸，收放时它们不动，
 * 代价是精炼态也得放得下那个 72px 的大数字 —— 半格 192px 里，顶部占掉 99px，
 * 剩 33px 给量程条和端口行（它们要 30px）。再矮就塞不下了。
 *
 * 用行内样式而不是 Tailwind 类：下面每张卡的高度要按这个数算出来喂给动画，
 * 常量只留一份，不会哪天改了类名忘了改 JS。
 */
const SLOT_PX = 396;
/** 平分时两张卡之间的缝，和页面网格的 gap-3 一致 */
const STACK_GAP_PX = 12;
const HALF_PX = (SLOT_PX - STACK_GAP_PX) / 2;

const CHARGER_TRANSITION = {
  duration: 0.36,
  ease: [0.22, 1, 0.36, 1] as const,
};

type Slot = "charger" | "powerBank";

/**
 * 充电卡与最近播放共享一个布局状态：
 *
 * - 单列时，充电卡所在的网格轨道收拢，最近播放顺势上移；
 * - 双列时，充电卡保留行高但淡出，最近播放用 FLIP 从右格铺满整行。
 *
 * **充电头和充电宝共用左边这一格。** 谁真的在收放电就显示谁，两台都在动时上下平
 * 分、各自切到精炼形态 —— 整格高度始终不变，右边那张最近播放贴着这一行，一涨它
 * 就得重排。都不在动时整格收起。
 *
 * 两张卡都始终挂载，只是把没轮到的那张 display:none：卸载了它就收不到下一次轮询
 * 和推送，也就永远不知道自己该回来了。
 */
export function LiveMediaPair({
  chargerFallback,
  powerBankFallback,
  listeningFallback,
  nowListeningFallback,
  lyricsFallback,
  artworkPlaceholders,
}: {
  chargerFallback: StatusResponse<ChargerPayload>;
  powerBankFallback: StatusResponse<PowerBankPayload>;
  listeningFallback: StatusResponse<ListeningPayload>;
  nowListeningFallback: StatusResponse<NowListeningPayload>;
  /** 首屏同步歌词，由服务端在直读 Redis 缓存后冻进首屏 HTML */
  lyricsFallback?: LyricsFallback | null;
  /** 首屏封面的低清占位表，见 lib/artwork-placeholder；只透传给 ListeningCard */
  artworkPlaceholders: ArtworkPlaceholders;
}) {
  const [chargerActive, setChargerActive] = useState(
    chargerFallback.ok &&
      chargerFallback.data.connected &&
      chargerFallback.data.totalPower > 1,
  );
  const [powerBankActive, setPowerBankActive] = useState(
    powerBankFallback.ok &&
      powerBankFallback.data.connected &&
      (powerBankFallback.data.inputPower > 1 || powerBankFallback.data.outputPower > 1),
  );
  const [chargerOverride, setChargerOverride] = useState<boolean | null>(null);
  const [powerBankOverride, setPowerBankOverride] = useState<boolean | null>(null);
  const isDev = process.env.NODE_ENV === "development";

  const chargerOn = isDev && chargerOverride !== null ? chargerOverride : chargerActive;
  const powerBankOn =
    isDev && powerBankOverride !== null ? powerBankOverride : powerBankActive;
  const isVisible = chargerOn || powerBankOn;
  /** 两台都在动：这一格上下平分，两张卡各自切到精炼形态 */
  const both = chargerOn && powerBankOn;

  /**
   * 淡出期间继续显示刚才那张卡。不记住的话，充电宝停下的那一刻格子会先闪回充电头
   * 再淡出 —— 观众看到的是一次错误的换卡，而不是一次收起。
   */
  const [lastShown, setLastShown] = useState<Slot>("charger");
  const shown: Slot = chargerOn ? "charger" : powerBankOn ? "powerBank" : lastShown;
  // 渲染期间就地对齐，不放进 effect：这样换卡和淡出发生在同一帧，中间不会先画错一次
  if (shown !== lastShown) setLastShown(shown);

  /**
   * 这一格里谁露脸：两张都在动时都露，否则只有 `shown` 那张。
   *
   * 两张都不在动时 `shown` 落回 `lastShown`，所以整格淡出的那 0.36 秒里，画面上
   * 还是刚才那张卡在原尺寸上淡掉，而不是先塌成 0 再淡。
   */
  const showing = (slot: Slot) => both || shown === slot;
  const heightFor = (slot: Slot) => (both ? HALF_PX : showing(slot) ? SLOT_PX : 0);

  const reduced = useReducedMotion();
  const handleChargerActive = useCallback((nextActive: boolean) => {
    setChargerActive((current) => (current === nextActive ? current : nextActive));
  }, []);
  const handlePowerBankActive = useCallback((nextActive: boolean) => {
    setPowerBankActive((current) => (current === nextActive ? current : nextActive));
  }, []);

  return (
    <div className="md:col-span-2">
      <div
        className={cn(
          "live-media-pair grid grid-cols-1 md:grid-cols-2 md:items-stretch",
          isVisible ? "is-connected" : "is-disconnected",
        )}
      >
        <motion.div
          initial={false}
          animate={
            reduced
              ? { opacity: isVisible ? 1 : 0, x: 0, scale: 1 }
              : {
                  opacity: isVisible ? 1 : 0,
                  x: isVisible ? 0 : -8,
                  scale: isVisible ? 1 : 0.985,
                }
          }
          transition={reduced ? { duration: 0 } : CHARGER_TRANSITION}
          className={cn(
            "charger-shell min-w-0 origin-left",
            !isVisible && "pointer-events-none",
          )}
          aria-hidden={!isVisible}
        >
          <div
            className={cn(
              "charger-collapse min-h-0 md:h-full md:overflow-visible",
              // 展开时不能 hidden：3px 的 paper-card 硬阴影在右下，会被裁掉。
              // 单列收起仍要 hidden，否则 0fr 轨道夹不住内容。
              isVisible ? "overflow-visible" : "overflow-hidden",
            )}
          >
            {/*
              两台都在动时上下平分这一格，各自切到精炼形态。整格高度不变 ——
              旁边那张最近播放是 inset-block:0 贴着这一行的，这里一涨它就得重排。

              高度用 motion 插值，不靠 display:none 硬切：一张卡从 380 收到 0、另一
              张同时从 0 长到 380，两个数在同一条曲线上走，缝也跟着开合，所以整格
              始终正好是 380，中间没有哪一帧会把右边那张列表挤一下。
            */}
            <div className="flex flex-col" style={{ height: SLOT_PX }}>
              <motion.div
                initial={false}
                animate={{ height: heightFor("charger"), opacity: showing("charger") ? 1 : 0 }}
                transition={reduced ? { duration: 0 } : CHARGER_TRANSITION}
                className={cn(
                  // 高度插值时内容裁切交给 Card 自己的 overflow-hidden + h-full。
                  // 这里再 hidden 会把 paper-card 那 3px 硬阴影裁掉。
                  "min-h-0",
                  !showing("charger") && "pointer-events-none",
                )}
                aria-hidden={!showing("charger")}
              >
                <ChargerCard
                  fallback={chargerFallback}
                  className="h-full"
                  onActiveChange={handleChargerActive}
                  compact={both}
                />
              </motion.div>
              <motion.div
                initial={false}
                animate={{
                  height: heightFor("powerBank"),
                  opacity: showing("powerBank") ? 1 : 0,
                  // 缝只在两张都在时存在，否则 380 + 12 会顶破整格
                  marginTop: both ? STACK_GAP_PX : 0,
                }}
                transition={reduced ? { duration: 0 } : CHARGER_TRANSITION}
                className={cn(
                  "min-h-0",
                  !showing("powerBank") && "pointer-events-none",
                )}
                aria-hidden={!showing("powerBank")}
              >
                <PowerBankCard
                  fallback={powerBankFallback}
                  className="h-full"
                  onActiveChange={handlePowerBankActive}
                  compact={both}
                />
              </motion.div>
            </div>
          </div>
        </motion.div>

        <div className="listening-shell min-w-0">
          <ListeningCard
            fallback={listeningFallback}
            nowFallback={nowListeningFallback}
            lyricsFallback={lyricsFallback}
            artworkPlaceholders={artworkPlaceholders}
            className="h-full"
            wide={!isVisible}
          />
        </div>
      </div>

      {isDev && (
        <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
          <DevToggle
            label="Charger"
            on={chargerOn}
            onClick={() => setChargerOverride((prev) => (prev !== null ? !prev : !chargerActive))}
          />
          <DevToggle
            label="Power Bank"
            on={powerBankOn}
            onClick={() =>
              setPowerBankOverride((prev) => (prev !== null ? !prev : !powerBankActive))
            }
          />
        </div>
      )}
    </div>
  );
}

/** 开发环境调试：单独强制某张卡的可见性，用来看两张卡抢同一个格子的效果 */
function DevToggle({
  label,
  on,
  onClick,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="paper-card flex h-8 items-center gap-2 rounded-md border border-line-strong bg-surface px-3 text-xs text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
      title={`开发环境调试：切换${label}面板可见性`}
    >
      <StatusDot tone={on ? "live" : "off"} />
      <span className="label-mono">
        {label}: {on ? "Shown" : "Hidden"}
      </span>
    </button>
  );
}
