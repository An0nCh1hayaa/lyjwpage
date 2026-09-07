"use client";

import Image from "next/image";
import { Fragment, type CSSProperties } from "react";

import { appleArtwork, ARTWORK_SCALE, needsOptimizing } from "@/lib/apple-artwork";
import { cn } from "@/lib/utils";

/**
 * 播放器里的两张封面：弹窗展开页那张和页头缩略播放器那张。
 *
 * 只认专辑 / 歌单自己的封面，不按正在放的那首换：预载的是这一张，换成逐曲
 * 封面（歌单里每首都不同）就又要等一次加载，正是这个组件要避免的事。
 */
export const DIALOG_ARTWORK_PX = 96;
export const MINI_ARTWORK_PX = 24;

/**
 * 弹窗、缩略播放器和预载三处必须走同一个组件：`next/image` 按 sizes 和
 * unoptimized 算出的地址要逐字相同，预载那次才能命中缓存。任何一处自己拼
 * `<Image>`，预载就白做了。
 */
export function PlayerArtwork({
  artwork,
  size,
  className,
  style,
  eager = false,
}: {
  /** Apple 的模板 URL；null 只画灰底 */
  artwork: string | null;
  size: number;
  className?: string;
  style?: CSSProperties;
  /** 预载用：离屏元素默认懒加载，永远不会进视口，得强制拉 */
  eager?: boolean;
}) {
  const src = appleArtwork(artwork, size * ARTWORK_SCALE);
  const defaultSizeStyle = className?.includes("size-") ? undefined : { width: size, height: size };
  return (
    <div
      className={cn("relative shrink-0 overflow-hidden bg-muted", className)}
      style={{ ...defaultSizeStyle, ...style }}
    >
      {src ? (
        <Image
          src={src}
          alt=""
          fill
          sizes={`${size}px`}
          className="object-cover"
          unoptimized={!needsOptimizing(artwork)}
          loading={eager ? "eager" : undefined}
          // 预载的优先级压到最低：它不该和首屏的封面、动态封面抢带宽
          fetchPriority={eager ? "low" : undefined}
        />
      ) : null}
    </div>
  );
}

/**
 * 把能进播放器的那几张封面按弹窗和缩略图的尺寸提前拉下来。
 *
 * 用真的 `<Image>` 离屏渲染而不是 `new Image()` 或 `<link rel=preload>`：走图片
 * 优化器的那几张（自建歌单的资料库封面）最终地址是 next/image 按 srcset 算的，
 * 手拼很难逐字对上；同一个组件渲染出来的才一定一样。容器钉在视口外、1px、
 * 不可见也不可点，读屏也跳过。
 */
export function PlayerArtworkPreload({ artworks }: { artworks: string[] }) {
  if (artworks.length === 0) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed -left-[9999px] top-0 size-px overflow-hidden"
    >
      {artworks.map((artwork) => (
        <Fragment key={artwork}>
          <PlayerArtwork artwork={artwork} size={DIALOG_ARTWORK_PX} eager />
          <PlayerArtwork artwork={artwork} size={MINI_ARTWORK_PX} eager />
        </Fragment>
      ))}
    </div>
  );
}
