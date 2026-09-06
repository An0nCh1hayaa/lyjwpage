"use client";

import type { Level } from "hls.js";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";

import { appleArtwork, ARTWORK_SCALE, needsOptimizing } from "@/lib/apple-artwork";
import type { ArtworkDataUri } from "@/lib/artwork-placeholder";
import { cn } from "@/lib/utils";

/**
 * 在母播放列表里挑「够用的最小档」，返回 hls.js 的档位下标。
 *
 * 不挑的话 ABR 只看带宽：实测给这张 80px 的封面选了 960×960 / 3.8Mbps 那档，
 * 再由 GPU 双线性压到 ~160 设备像素。六倍下采样每个目标像素只取 4 个源像素，
 * 动画线稿的锯齿就是这么来的 —— 流量还白花十几倍。Apple 这支母列表有 29 个
 * 档位，最小的 360×360 只要 261kbps。
 *
 * 同一尺寸有多个码率时取最低的：像素数已经够了，多出来的比特只是更大的文件。
 */
function smallestAdequateLevel(levels: Level[], video: HTMLVideoElement): number {
  if (!levels.length) return -1;

  const dpr = window.devicePixelRatio || 1;
  // 元素还没上屏时 rect 是 0，退回设计稿上的 80px
  const box = Math.round(video.getBoundingClientRect().width) || 80;
  const target = box * dpr;

  const bySize = levels
    .map((level, index) => ({ index, width: level.width, bitrate: level.bitrate }))
    .sort((a, b) => a.width - b.width || a.bitrate - b.bitrate);

  // 全都比盒子小就用最大的那个，总比拿一档更糊的强
  return (bySize.find((level) => level.width >= target) ?? bySize[bySize.length - 1])
    .index;
}

export function HeroMotionArtwork({
  artwork,
  title,
  videoUrl,
  placeholder,
  reduced = false,
  sizePx = 80,
}: {
  artwork: string | null;
  title: string;
  videoUrl: string | null | undefined;
  /** 首屏低清占位，见 lib/artwork-placeholder；没有就传 undefined，退回 empty */
  placeholder?: ArtworkDataUri;
  reduced?: boolean;
  /**
   * 边长。卡片 hero 是 80；网页播放器弹窗用 96 —— 那边预载的封面就是按 96 取的
   * （见 web-player/player-artwork），这里的 `<Image>` 必须按同一尺寸拼地址才能命中。
   */
  sizePx?: number;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoUrl || reduced) return;

    let unmounted = false;
    let hls: { destroy: () => void } | null = null;
    let fellBack = false;
    let frameHandle = 0;

    setIsPlaying(false);
    // 自动播放策略只认播放那一刻的静音状态，属性写过一遍不够保险
    video.muted = true;
    video.defaultMuted = true;

    /**
     * 换 hls.js 接管。只在原生播放确实报错后才走这里，所以 Safari 那条路
     * 一个字节的库都不用下（~400KB，而首屏这张封面是全站 LCP 元素）。
     */
    const startHls = async () => {
      if (fellBack) return;
      fellBack = true;

      const { default: Hls } = await import("hls.js");
      if (unmounted || !Hls.isSupported()) return;

      // 先把放不动的那个源摘干净，再交给 MSE
      video.removeAttribute("src");
      video.load();

      // 等挑完档位再放码流，免得 ABR 先按带宽抓一片 3.8Mbps 的回来
      const instance = new Hls({
        autoStartLoad: false,
        maxBufferLength: 10,
        enableWorker: true,
      });
      hls = instance;

      instance.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            instance.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            instance.recoverMediaError();
            break;
          default:
            instance.destroy();
            break;
        }
      });
      instance.on(Hls.Events.MANIFEST_PARSED, () => {
        if (unmounted) return;
        const level = smallestAdequateLevel(instance.levels, video);
        if (level >= 0) {
          // 钉死，不让 ABR 再往上跳：带宽够不是往上挑的理由，这个盒子就这么大
          instance.startLevel = level;
          instance.currentLevel = level;
        }
        instance.startLoad();
        video.play().catch(() => {});
      });

      instance.loadSource(videoUrl);
      instance.attachMedia(video);
      // 源换成了 MSE，之前挂在原生源上的那个帧回调不作数了
      awaitFirstFrame();
    };

    /*
     * 淡入的起点必须是「已经上屏的真帧」，不能是 playing。
     *
     * Safari 的 playing 早于首帧合成：那时候开始淡，淡完的是 poster——
     * 和底下那张静态图一模一样，看不出来——等首帧真来了再无过渡地顶上去。
     * 动态封面的构图跟静态封面差一点点，这一下换就是肉眼可见的位移。Chrome 的
     * playing 来得晚，帧已经在了，所以那边一直是好的。
     *
     * rVFC 是「这帧已经合成」的准确信号。timeupdate 兜底：它第一次触发时播放
     * 已经推进了几百毫秒，帧必然在了，免得 rVFC 万一不来就再也不显示。
     */
    const reveal = () => {
      if (!unmounted) setIsPlaying(true);
    };

    const awaitFirstFrame = () => {
      if (!("requestVideoFrameCallback" in video)) return;
      if (frameHandle) video.cancelVideoFrameCallback(frameHandle);
      frameHandle = video.requestVideoFrameCallback(() => {
        frameHandle = 0;
        reveal();
      });
    };

    const onTimeUpdate = () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      reveal();
    };

    const onError = () => {
      setIsPlaying(false);
      void startHls();
    };
    // VOD 流在 Safari 里偶尔不认 loop，手动兜一次
    const onEnded = () => {
      video.currentTime = 0;
      video.play().catch(() => {});
    };

    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("error", onError);
    video.addEventListener("ended", onEnded);
    awaitFirstFrame();

    /*
     * 先按原生 HLS 播。这里不能用 canPlayType 分流：Chromium 对
     * application/vnd.apple.mpegurl 一律回 "maybe"，实际拿到 .m3u8 直接
     * MEDIA_ERR_SRC_NOT_SUPPORTED —— 之前就是被这句谎话骗进原生分支，
     * hls.js 一次都没跑过。改成让它自己撞墙，撞了再换。
     */
    video.src = videoUrl;
    video.play().catch(() => {});

    return () => {
      unmounted = true;
      if (frameHandle) video.cancelVideoFrameCallback(frameHandle);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("error", onError);
      video.removeEventListener("ended", onEnded);
      hls?.destroy();
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [videoUrl, reduced]);

  return (
    <div
      className="relative aspect-square shrink-0 overflow-hidden rounded-md border border-line bg-muted"
      style={{ width: sizePx }}
      /*
       * 不垫主色纯色块 —— 上过一次线又撤下来的教训：占位解码滑档那一两帧会
       * 闪出一整块显眼色块，比 bg-muted 的灰底更扎眼，等于把加载过程演出来。
       * 现在两处（这里和 listening-card 的行）都改成同步解码的垫底图，占位
       * 和首帧原子地一起画，压根没有「滑档露底」这一帧，主色层因此退役。
       */
      onMouseEnter={() => {
        // 自动播放被拒（比如 Safari 低电量模式）不会报 error，留个手动入口
        if (videoRef.current && videoUrl && !reduced) {
          videoRef.current.play().catch(() => {});
        }
      }}
    >
      {/* hover 缩放放在普通 div 上：<video> 的 transition-opacity 管不了 scale，
          而且有的浏览器对 video 自身的 transform 插值不稳定。 */}
      <div className="absolute inset-0 transition-transform duration-500 group-hover:scale-[1.04]">
        {/*
         * 低清占位铺成真正的 <Image> 垫在真图下面，而不是走 placeholder 属性：
         * placeholder 是 CSS 背景图，没有 decoding 可控，移动端首帧前后主线程
         * 忙着水合时，背景解码会滑过首帧一两拍，露出底下的 bg-muted ——
         * hero 这个尺寸上就是一块肉眼可见的「空白一闪」。data URI + sync
         * 解码是浏览器保证与首帧原子绘制的（头像那块用的同一机制），真图
         * 在 DOM 里排它后面，加载完自然盖住它。
         */}
        {placeholder && (
          <Image
            src={placeholder}
            alt=""
            aria-hidden
            fill
            sizes={`${sizePx}px`}
            className="object-cover"
            decoding="sync"
          />
        )}
        {artwork && (
          <Image
            src={appleArtwork(artwork, sizePx * ARTWORK_SCALE)!}
            alt={`${title} 封面`}
            fill
            sizes={`${sizePx}px`}
            // 这张是全站 LCP 元素：默认的 lazy 会让预加载扫描器跳过它
            loading="eager"
            fetchPriority="high"
            className="object-cover"
            unoptimized={!needsOptimizing(artwork)}
          />
        )}

        {videoUrl && !reduced && (
          <video
            ref={videoRef}
            autoPlay
            loop
            muted
            playsInline
            aria-hidden
            /*
             * 没有 poster 的 <video> 在首帧到达前是「空媒体」，Safari 会给它画一个
             * 问号占位符（Chrome 画的是透明，所以只在 Safari 上看得见）。指到同一张
             * 静态封面上，这一层在任何时刻都和底下那张图长得一样：占位符没了，
             * 动态接管的那一下也不会闪。
             */
            poster={artwork ? (appleArtwork(artwork, sizePx * ARTWORK_SCALE) ?? undefined) : undefined}
            className={cn(
              "absolute inset-0 size-full object-cover transition-opacity duration-[1.2s] ease-[cubic-bezier(0.45,0,0.55,1)]",
              isPlaying ? "opacity-100" : "pointer-events-none opacity-0",
            )}
          />
        )}
      </div>
    </div>
  );
}
