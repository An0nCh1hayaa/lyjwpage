"use client";

import NumberFlow from "@number-flow/react";
import { CircleQuestionMark } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { StatusDot } from "@/components/ui/status-dot";
import { useOnlineCount } from "@/hooks/use-online-count";

/**
 * 页脚右侧的「此刻在线」。
 *
 * 连接 Cloudflare Workers 的 Durable Objects 实例，
 * 实时同步在线人数。
 */
export function OnlineCount() {
  const { count, connected } = useOnlineCount();

  return (
    <span className="label-mono flex items-center gap-2 text-muted-foreground">
      <StatusDot tone={connected ? "live" : "off"} />
      <span className="flex items-center gap-1">
        此刻在线
        {/* SSR 就保留数字位置；不能写 0，那会把“还没连上”伪装成真实人数。 */}
        <span className="inline-grid text-foreground" aria-live="polite">
          {/* 两层始终在同一个格子里参与尺寸计算，只切 visibility，替换时宽度不变。 */}
          <span
            className={`col-start-1 row-start-1 justify-self-end text-muted-foreground ${count == null ? "" : "invisible"}`}
            aria-hidden
          >
            --
          </span>
          <NumberFlow
            value={count ?? 0}
            locales="en-US"
            format={{ minimumIntegerDigits: 2 }}
            className={`col-start-1 row-start-1 justify-self-end ${count == null ? "invisible" : ""}`}
            aria-hidden
          />
          <span className="sr-only">
            {count == null ? "正在获取在线人数" : count.toLocaleString("en-US")}
          </span>
        </span>
      </span>
      <SourceHint connected={connected} />
    </span>
  );
}

/** 问号：点开说明这个数字是哪来的。点外面或按 Esc 关掉。 */
function SourceHint({ connected }: { connected: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <span ref={root} className="relative inline-flex">
      <button
        type="button"
        aria-label="数据来源"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
      >
        <CircleQuestionMark className="size-3.5" aria-hidden />
      </button>

      {open && (
        // 页脚是居中的，浮层跟着触发点居中；w-64 在 375px 的手机上也不会顶到边
        <span className="absolute bottom-full left-1/2 z-50 mb-2 w-64 -translate-x-1/2 rounded-lg border border-line bg-surface p-3">
          <span className="label-mono block text-foreground">数据来源</span>
          <span className="mt-2 block text-xs normal-case leading-relaxed text-muted-foreground">
            连接 Cloudflare Workers 的 Durable Objects 实例，按前台活跃 WebSocket 连接实时计数。包括 Vercel 生产站点以及所有的预览构建。
          </span>
          <span className="mt-3 flex items-center justify-between border-t border-line pt-2.5">
            <span className="label-mono text-muted-foreground">WebSocket</span>
            <span className="label-mono flex items-center gap-1.5 text-foreground">
              <StatusDot tone={connected ? "live" : "off"} />
              {connected ? "已连接" : "已断开"}
            </span>
          </span>
        </span>
      )}
    </span>
  );
}
