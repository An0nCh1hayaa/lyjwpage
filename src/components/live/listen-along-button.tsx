"use client";

import { useCallback, useId, useState } from "react";
import { CircleStop, Headphones, TriangleAlert, X } from "lucide-react";

import { Modal } from "@/components/ui/modal";
import type { ListenAlong } from "@/hooks/use-listen-along";
import { cn } from "@/lib/utils";

/**
 * 卡片右上角那个 Listen Along。
 *
 * 点开先出说明：授权自己的订阅、站点不转音频不存凭据。标题旁标 beta。
 * 没点 Sign in 之前不加载 MusicKit，按钮先占位。出声后右上角才变绿。
 */

function face(listen: ListenAlong) {
  const loading =
    listen.status === "starting" || (listen.status === "following" && !listen.audible && !listen.waiting);
  if (loading) {
    return {
      icon: <Headphones className="size-3 shrink-0" aria-hidden />,
      text: "Connecting...",
      label: "Loading, audio has not started yet",
    };
  }
  if (listen.status === "error") {
    return {
      icon: <TriangleAlert className="size-3 shrink-0" aria-hidden />,
      text: "Retry",
      label: `Listen Along failed: ${listen.error ?? "unknown error"}. Open details`,
    };
  }
  if (listen.status === "following") {
    return {
      icon: <CircleStop className="size-3 shrink-0" aria-hidden />,
      text: listen.waiting ? "Waiting" : "Listen Along",
      label: listen.waiting
        ? "Connected, waiting for playback to start. Open details"
        : "Listening along. Open details",
    };
  }
  return {
    icon: <Headphones className="size-3 shrink-0" aria-hidden />,
    text: "Listen Along",
    label: "Open Listen Along details",
  };
}

export function DialogButton({
  children,
  onClick,
  disabled,
}: {
  children: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="label-mono min-w-0 flex-1 py-2.5 text-center text-foreground transition-colors hover:bg-surface-hover disabled:cursor-default disabled:opacity-60"
    >
      {children}
    </button>
  );
}

function ListenAlongDialog({
  listen,
  onClose,
}: {
  listen: ListenAlong;
  onClose: () => void;
}) {
  const titleId = useId();
  const busy = listen.status === "starting";

  return (
    <Modal titleId={titleId} onClose={onClose}>
      <header className="flex items-center justify-between gap-2 px-4">
        <div className="flex items-center gap-1.5">
          <span id={titleId} className="label-mono text-muted-foreground">
            Listen Along
          </span>
          <span className="label-mono text-muted-foreground/60">beta</span>
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </header>
      <p className="mt-3 px-4 text-sm leading-relaxed text-foreground">
        请登录有效的 Apple Music 订阅授权。站点不转发音频、储存凭据，仅同步播放曲目和进度。
      </p>
      {listen.error ? (
        <p className="mt-2 px-4 text-sm text-muted-foreground">{listen.error}</p>
      ) : null}
      <div className="mt-4 flex border-t border-line">
        <DialogButton
          disabled={busy}
          onClick={() => {
            if (listen.status === "following") {
              listen.stop();
              onClose();
              return;
            }
            listen.start();
          }}
        >
          {busy
            ? "Connecting..."
            : listen.status === "following"
              ? "Stop"
              : listen.authorized
                ? "Start"
                : "Sign in"}
        </DialogButton>
        {listen.authorized ? (
          <>
            <div className="w-px self-stretch bg-line" aria-hidden />
            <DialogButton
              disabled={busy}
              onClick={() => {
                listen.logout();
                onClose();
              }}
            >
              Sign out
            </DialogButton>
          </>
        ) : null}
      </div>
    </Modal>
  );
}

export function ListenAlongButton({ listen }: { listen: ListenAlong }) {
  const [open, setOpen] = useState(false);
  // 稳定引用：对话框的 keydown effect 依赖它，内联箭头会让监听每渲染重挂一次
  const close = useCallback(() => setOpen(false), []);

  if (listen.status === "unavailable") return null;

  const { icon, text, label } = face(listen);
  const live = listen.status === "following" && listen.audible && !listen.waiting;

  return (
    <>
      <button
        type="button"
        aria-label={label}
        title={listen.status === "error" ? (listen.error ?? undefined) : label}
        onClick={() => setOpen(true)}
        className={cn(
          "label-mono flex items-center gap-1.5 transition-colors",
          live ? "text-live hover:text-live/80" : "hover:text-foreground",
        )}
      >
        {icon}
        <span>{text}</span>
      </button>
      {open ? <ListenAlongDialog listen={listen} onClose={close} /> : null}
    </>
  );
}
