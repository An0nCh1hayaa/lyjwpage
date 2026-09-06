import { HeaderDesktop } from "@/components/live/live-desk-card";
import { HomeLink } from "@/components/home-link";
import { ThemeToggle } from "@/components/theme-toggle";
import { MiniPlayer } from "@/components/web-player/mini-player";
import type { DesktopPayload, StatusResponse } from "@/lib/types";

export function Header({
  desktop,
  desktopIconDataUri,
}: {
  desktop: StatusResponse<DesktopPayload>;
  /** 首屏那枚图标的内联副本，见 lib/desktop-icon-inline；压不出来是 null */
  desktopIconDataUri: string | null;
}) {
  return (
    <header className="sticky top-0 z-50 bg-background/95 backdrop-blur-sm">
      <div className="mx-auto w-[calc(100%-2rem)] max-w-5xl py-3 sm:py-4">
        <div className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3">
          <HomeLink />
          <HeaderDesktop fallback={desktop} iconDataUri={desktopIconDataUri} />
          <div className="flex items-center gap-2 justify-self-end">
            <MiniPlayer />
            <ThemeToggle />
          </div>
        </div>
      </div>
    </header>
  );
}
