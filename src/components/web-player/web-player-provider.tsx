"use client";

import { createContext, useContext, type ReactNode } from "react";

import { WebPlayerDialog } from "@/components/web-player/web-player-dialog";
import { useWebPlayerState, type WebPlayer } from "@/hooks/use-web-player";

const WebPlayerContext = createContext<WebPlayer | null>(null);

export function WebPlayerProvider({ children }: { children: ReactNode }) {
  const player = useWebPlayerState();

  return (
    <WebPlayerContext.Provider value={player}>
      {children}
      {player.open && player.item ? <WebPlayerDialog player={player} /> : null}
    </WebPlayerContext.Provider>
  );
}

/**
 * 获取网页播放器上下文。
 * 没有 Provider 时返回 null（如 error.tsx / not-found.tsx 等独立页面的页头）。
 */
export function useWebPlayer(): WebPlayer | null {
  return useContext(WebPlayerContext);
}
