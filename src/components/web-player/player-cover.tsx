"use client";

import { useReducedMotion } from "motion/react";

import { HeroMotionArtwork } from "@/components/live/hero-motion-artwork";
import { DIALOG_ARTWORK_PX } from "@/components/web-player/player-artwork";
import { useMotionArtwork } from "@/hooks/use-motion-artwork";
import type { ListeningItem } from "@/lib/types";

/**
 * 弹窗里那张封面：有动态封面就放动态的，和卡片 hero 同一个组件。
 *
 * 动态封面按专辑 / 歌单的链接去问 `/api/motion-artwork?url=`（卡片问的是 hero
 * 那张，这里问的是访客点开的那张）。静态那层的 `<Image>` 按 DIALOG_ARTWORK_PX
 * 拼地址，和 player-artwork 预载的那张逐字相同，打开时直接命中缓存。
 */
export function PlayerCover({ item }: { item: ListeningItem | null }) {
  const { data } = useMotionArtwork(item?.link);
  const reduced = useReducedMotion();
  return (
    <HeroMotionArtwork
      artwork={item?.artwork ?? null}
      title={item?.title ?? ""}
      videoUrl={data?.hasMotion ? data.videoUrl : null}
      reduced={Boolean(reduced)}
      sizePx={DIALOG_ARTWORK_PX}
    />
  );
}
