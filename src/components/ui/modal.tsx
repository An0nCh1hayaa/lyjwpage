"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

export function Modal({
  titleId,
  onClose,
  className,
  children,
}: {
  titleId: string; // 调用方用 useId() 生成，标题元素上放同一个 id
  onClose: () => void; // 必须是稳定引用（useCallback），effect 依赖它
  className?: string; // 面板额外类名（如 max-w-sm / max-w-md）
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  /**
   * 打开时把焦点接进来、关掉时还回去，中间 Tab 不许走出对话框。
   *
   * `aria-modal="true"` 只管读屏的虚拟光标，键盘的 Tab 照样能落到背后的卡片
   * 链接上 —— 何况这个对话框是 createPortal 到 body 的，DOM 顺序上就在最后，
   * 走出去之后再也 Tab 不回来。
   */
  useEffect(() => {
    const panel = panelRef.current;
    // 焦点先给容器而不是第一个按钮：starting 时按钮是 disabled 的，聚不上去
    const restoreTo = document.activeElement as HTMLElement | null;
    panel?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const items = Array.from(
        panel.querySelectorAll<HTMLElement>(
          "button:not([disabled]), a[href], input:not([disabled])",
        ),
      );
      const active = document.activeElement;
      const inside = panel.contains(active);
      if (items.length === 0) {
        // 全 disabled（连接中）：把焦点按在容器上，Tab 也别溜出去
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (!inside || active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
      // 不还回去的话焦点会掉到 <body>，键盘用户要从页首重新 Tab 一遍
      restoreTo?.focus?.();
    };
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* 遮罩只是「点外面关掉」的鼠标热区：它不该是第二个叫 Close 的按钮，
          可访问的关闭入口留给头部那个 X 和 Escape */}
      <div className="absolute inset-0 bg-background/80" aria-hidden onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn("relative w-full max-w-sm bg-surface pt-3 outline-none", className)}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
