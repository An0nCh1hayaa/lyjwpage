"use client";

import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useMountedAt } from "@/hooks/use-mounted-at";
import { cueAt } from "@/lib/lyrics-cue";
import type { LyricLine, LyricWord } from "@/lib/lyrics-ttml";
import { trackPositionMs } from "@/lib/track-position";
import type { LocalNowPlaying } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * 同步歌词的几个展示件，从 listening-card 里拆出来：网页播放器的弹窗也要显示
 * 访客正在放那首的歌词，而它不能反过来 import listening-card（那边 import 了
 * 播放器的 Provider，会绕成一个圈）。三处读的都是 lib/track-position 那份
 * 算法：传进来的 track 是一个锚点（state / observedAt / positionMs），位置由
 * 各自的计时器往前推，字亮到哪儿、句换到哪儿和进度条永远对得上。
 */

/**
 * 歌词换句的过渡：新句从下方一小步淡入，旧句向上淡出，像歌词滚了一格。
 * 位移压得很小（4px）：这一行是在 hero 里跟着节拍换的，动大了就成了干扰。
 * 出场比入场快，理由同 HERO_VARIANTS —— 两句半透明地叠着会糊成重影。
 */
export const LYRIC_LINE_VARIANTS = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.26, ease: [0.22, 1, 0.36, 1] } },
  exit: { opacity: 0, y: -4, transition: { duration: 0.14, ease: "easeIn" } },
};

/**
 * 逐字点亮的一句。
 *
 * 每个字一个 span，`--sung` 是这个字唱到了几成，CSS 拿它画一条「已唱 / 未唱」两色
 * 的渐变裁进文字里（见 globals.css 的 .lyric-word）。播放中用 rAF 每帧算一遍：
 * 几十个字各算一个百分比，比让 React 每帧重渲染便宜得多，所以直接写 DOM，不进
 * state。暂停时算一次就停，字停在唱到的那一格。
 *
 * position 和进度条、换句的闹钟是同一份算法（lib/track-position），字亮到哪儿
 * 和进度条走到哪儿永远对得上。
 */
export function LyricWords({ words, track }: { words: LyricWord[]; track: LocalNowPlaying }) {
  const ref = useRef<HTMLSpanElement>(null);
  const { state, observedAt, positionMs, durationMs, repeatOne } = track;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const anchor = { state, observedAt, positionMs, durationMs, repeatOne };

    const paint = () => {
      const at = trackPositionMs(anchor, Date.now());
      words.forEach((word, i) => {
        const span = node.children[i] as HTMLElement | undefined;
        if (!span) return;
        const lengthMs = word.endMs - word.startMs;
        const ratio =
          lengthMs <= 0
            ? at >= word.startMs
              ? 1
              : 0
            : Math.max(0, Math.min(1, (at - word.startMs) / lengthMs));

        if (ratio <= 0) {
          if (span.dataset.sung !== "pending") {
            span.dataset.sung = "pending";
            span.style.removeProperty("--sung");
          }
        } else if (ratio >= 1) {
          if (span.dataset.sung !== "done") {
            span.dataset.sung = "done";
            span.style.removeProperty("--sung");
          }
        } else {
          span.dataset.sung = "active";
          span.style.setProperty("--sung", `${(ratio * 100).toFixed(1)}%`);
        }
      });
    };

    paint();
    if (state !== "playing") return;
    let frame = requestAnimationFrame(function loop() {
      paint();
      frame = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(frame);
  }, [words, state, observedAt, positionMs, durationMs, repeatOne]);

  return (
    <span ref={ref}>
      {words.map((word, i) => (
        // 首帧全部未唱，挂载后 paint 立刻改成当下的值
        <span key={i} className="lyric-word" data-sung="pending">
          {word.text}
        </span>
      ))}
    </span>
  );
}

/**
 * 宽屏状态下右侧的纵向滚动同步歌词。
 *
 * 钉在 h-20（80px）高度内，每行高度 26px。
 * 当前唱到的那句始终在中心（y=27px），前一句在上方，后一句在下方。
 * 上下边缘施加渐变遮罩，使歌词平滑淡入和淡出。
 * 有逐字时间轴时，当前那句按字从左到右点亮（LyricWords）。
 */
export function HeroLyrics({
  lyrics,
  track,
  songwriters,
  reduced = false,
}: {
  lyrics: LyricLine[];
  track: LocalNowPlaying;
  songwriters?: string[];
  reduced?: boolean;
}) {
  const playing = track.state === "playing";
  const mountedAt = useMountedAt();
  const [ticked, setTicked] = useState(0);
  const now = ticked || mountedAt;

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setTicked(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [playing]);

  const displayLyrics = useMemo(() => {
    if (!lyrics.length) return lyrics;
    const first = lyrics[0];
    const last = lyrics[lyrics.length - 1];
    const creator = (
      songwriters && songwriters.length > 0 ? songwriters.join("、") : track.artist
    )?.trim();

    // 1. 开头：类似 Apple Music 的 3 个 · 作为启动信号
    // 若首句有前奏，在开口前最多 2.4 秒内通过逐字计时依次点亮 3 个圆点
    const introLead = Math.min(Math.max(first.startMs, 0), 2_400);
    const introStart = Math.max(0, first.startMs - introLead);
    const dotDuration = introLead > 0 ? introLead / 3 : 0;

    const introLine: LyricLine = {
      startMs: 0,
      endMs: first.startMs,
      text: "···",
      words:
        dotDuration > 0
          ? [
              { startMs: introStart, endMs: introStart + dotDuration, text: "·" },
              { startMs: introStart + dotDuration, endMs: introStart + dotDuration * 2, text: "·" },
              { startMs: introStart + dotDuration * 2, endMs: first.startMs, text: "·" },
            ]
          : undefined,
    };

    // 2. 结尾：创作者:「真实词曲创作者 / 歌手」
    const outroStart = last.endMs;
    const outroEnd = Math.max(track.durationMs || 0, outroStart + 300_000);
    const outroLine: LyricLine = {
      startMs: outroStart,
      endMs: outroEnd,
      text: creator ? `创作者:「${creator}」` : "创作者",
    };

    return [introLine, ...lyrics, outroLine];
  }, [lyrics, songwriters, track.artist, track.durationMs]);

  const { observedAt, positionMs, durationMs, repeatOne } = track;
  useEffect(() => {
    if (!playing || !displayLyrics.length) return;
    const anchor = { state: "playing" as const, observedAt, positionMs, durationMs, repeatOne };
    const at = trackPositionMs(anchor, Math.max(now, Date.now()));
    const { until } = cueAt(displayLyrics, at);
    const target = until ?? (repeatOne && durationMs > 0 ? durationMs : null);
    if (target == null) return;
    const timer = window.setTimeout(() => setTicked(Date.now()), Math.max(16, target - at + 8));
    return () => window.clearTimeout(timer);
  }, [playing, displayLyrics, now, observedAt, positionMs, durationMs, repeatOne]);

  const position = trackPositionMs(track, now);
  const cue = cueAt(displayLyrics, position);

  let activeIdx = 0;
  let isSinging = false;
  // 歌词本体末句下标（不含结尾创作者行）
  const lastLyricIdx = Math.max(1, displayLyrics.length - 2);

  if (cue.index >= 0) {
    // 不跳到最后创作者行：焦点最大停在真实歌词末句
    activeIdx = Math.min(cue.index, lastLyricIdx);
    isSinging = cue.index <= lastLyricIdx;
  } else {
    // 间奏、前奏或尾声：寻找最近的一行保持视野连续
    let index = -1;
    for (let i = 0; i < displayLyrics.length && displayLyrics[i].startMs <= position; i += 1) {
      index = i;
    }
    activeIdx = Math.max(0, Math.min(index, lastLyricIdx));
    isSinging = false;
  }

  const LINE_HEIGHT = 26;
  // 视口滚动目标锁定在 [1, displayLyrics.length - 2]：
  // 开头 · · · 停在顶部行（Row 0），第一句歌词直接置于中间行；
  // 结尾「创作者」停在底部行（Row 2），最后一句歌词保持在中间行。
  // 头尾两端始终呈现完整三行内容，永不出现空白空行。
  const maxIdx = lastLyricIdx;
  const scrollIdx = Math.max(1, Math.min(activeIdx, maxIdx));
  const targetY = 27 - scrollIdx * LINE_HEIGHT;

  return (
    <div className="relative h-20 overflow-hidden [mask-image:linear-gradient(to_bottom,transparent_0%,black_16%,black_84%,transparent_100%)] [-webkit-mask-image:linear-gradient(to_bottom,transparent_0%,black_16%,black_84%,transparent_100%)]">
      <motion.div
        className="flex flex-col"
        animate={{ y: targetY }}
        transition={
          reduced
            ? { duration: 0 }
            : { duration: 0.36, ease: [0.22, 1, 0.36, 1] }
        }
      >
        {displayLyrics.map((line, i) => {
          const isCurrent = i === activeIdx;
          const isIntro = i === 0;
          const isOutro = i === displayLyrics.length - 1;

          return (
            <div
              key={i}
              className="flex h-[26px] items-center"
              style={{ height: `${LINE_HEIGHT}px` }}
            >
              <motion.span
                className={
                  isOutro
                    ? "block truncate text-xs text-muted-foreground/60 origin-left"
                    : cn(
                        "block truncate text-sm font-medium origin-left transition-colors duration-500 ease-out",
                        isIntro && "tracking-[0.08em] font-bold",
                        isCurrent
                          ? isSinging
                            ? "text-foreground"
                            : "text-foreground/80"
                          : isIntro
                            ? "text-muted-foreground/60"
                            : "text-muted-foreground",
                      )
                }
                animate={{
                  scale: isOutro ? 1 : isCurrent ? 1 : 0.88,
                  opacity: isOutro ? 0.6 : isCurrent ? 1 : 0.4,
                }}
                transition={
                  reduced
                    ? { duration: 0 }
                    : { duration: 0.36, ease: [0.22, 1, 0.36, 1] }
                }
                title={line.text}
              >
                {isCurrent && isSinging && line.words ? (
                  <LyricWords words={line.words} track={track} />
                ) : (
                  line.text
                )}
              </motion.span>
            </div>
          );
        })}
      </motion.div>
    </div>
  );
}

export function HeroLyricsSkeleton() {
  return (
    <div className="flex h-20 flex-col justify-center gap-2 py-2" aria-hidden>
      <div className="h-3 w-2/5 animate-pulse rounded bg-muted/50" />
      <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
      <div className="h-3 w-1/2 animate-pulse rounded bg-muted/50" />
    </div>
  );
}
