import { Footer } from "@/components/footer";
import { Header } from "@/components/header";
import { ContactCard } from "@/components/contact-card";
import { ActivityCard } from "@/components/live/activity-card";
import { LiveMediaPair } from "@/components/live/media-pair";
import { ServerCard } from "@/components/live/server-card";
import { PlaystationBlock } from "@/components/live/playstation-block";
import { TimezoneCard } from "@/components/live/timezone-card";
import { VibeCodingCard } from "@/components/live/vibecoding-card";
import { WatchingRow } from "@/components/live/watching-card";
import { Section } from "@/components/ui/section";
import { artworkPlaceholders } from "@/lib/artwork-placeholder";
import { desktopIconDataUri } from "@/lib/desktop-icon-inline";
import { githubAvatarDataUri } from "@/lib/github-avatar-icon";
import {
  cachedActivity,
  cachedServer,
  cachedCharger,
  cachedPowerBank,
  cachedDesktop,
  cachedGithubChart,
  cachedListening,
  cachedLyrics,
  cachedNowListening,
  cachedNowWatching,
  cachedPlaying,
  cachedPlayingNow,
  cachedTrophiesSummary,
  cachedTimezone,
  cachedVibeCoding,
  cachedVibeCodingYear,
  cachedWatching,
} from "@/lib/status-cache";

export default async function Home() {
  /**
   * 服务端并行读首屏数据。状态卡片使用 fallbackData；时区没有
   * status 轮询端点，在服务端预渲染时直接烧进静态 HTML。热力图也烧进去，
   * 客户端不在进页时回源，只按很长的间隔打热力图接口。
   *
   * 每份都是缓存过的（见 lib/status-cache）：整页因此能预渲染成静态壳，
   * 上报只把 page 标签标成 stale，访客先拿旧 HTML，取数重建留在后台。
   * 一份读失败只让那张卡拿到 ok:false，信封不会 reject，Promise.all 不会被拖垮。
   */
  const [
    desktop,
    activity,
    server,
    charger,
    powerBank,
    listening,
    nowListening,
    timezone,
    vibeCoding,
    vibeCodingYear,
    watching,
    nowWatching,
    playing,
    playingNow,
    trophies,
    githubChart,
    avatarDataUri,
  ] = await Promise.all([
    cachedDesktop("page"),
    cachedActivity("page"),
    cachedServer("page"),
    cachedCharger(),
    cachedPowerBank(),
    cachedListening("page"),
    cachedNowListening(),
    cachedTimezone(),
    cachedVibeCoding("page"),
    cachedVibeCodingYear("page"),
    cachedWatching("page"),
    cachedNowWatching(),
    cachedPlaying("page"),
    cachedPlayingNow("page"),
    cachedTrophiesSummary(),
    cachedGithubChart(),
    // 不是状态数据，是构建期就定死的那张头像 —— 一起 await 免得多排一轮
    githubAvatarDataUri(),
  ]);

  const nowSongId =
    nowListening.ok && !nowListening.data.idle && nowListening.data.hasLyrics
      ? nowListening.data.songId
      : null;

  /**
   * 内联素材与首屏歌词只能排在第二轮：要压哪几张、取哪首词写在信封里，进不了上面那批并行。
   * 桌面图标按 objectKey 缓存（lib/desktop-icon-inline）、封面占位按 Apple
   * 模板 URL 缓存（lib/artwork-placeholder）、歌词按 songId 缓存（lib/status-cache 的 cachedLyrics），
   * 命中后这里都不产生额外往返；三者彼此无关，未命中时并行把最坏等待压到单边的超时。
   */
  const [desktopIcon, artwork, lyrics] = await Promise.all([
    desktopIconDataUri(desktop.ok ? (desktop.data.desktop?.iconUrl ?? null) : null),
    artworkPlaceholders(
      listening.ok ? listening.data.items.map((item) => item.artwork) : [],
      nowListening.ok ? (nowListening.data.music?.artworkUrl ?? null) : null,
    ),
    nowSongId ? cachedLyrics(nowSongId) : null,
  ]);

  return (
    <>
      <Header desktop={desktop} desktopIconDataUri={desktopIcon} />

      <main className="flex-1">
        <div className="mx-auto my-3.5 w-[calc(100%-2rem)] max-w-5xl sm:my-4">
          <Section id="live" className="p-0 sm:p-0">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <ContactCard
                avatarDataUri={avatarDataUri}
                chartFallback={githubChart}
                yearFallback={vibeCodingYear}
              />
              <TimezoneCard fallback={timezone} />
              <LiveMediaPair
                chargerFallback={charger}
                powerBankFallback={powerBank}
                listeningFallback={listening}
                nowListeningFallback={nowListening}
                lyricsFallback={
                  nowSongId && lyrics && lyrics.lines.length
                    ? { songId: nowSongId, lines: lyrics.lines, songwriters: lyrics.songwriters }
                    : null
                }
                artworkPlaceholders={artwork}
              />
              <ActivityCard fallback={activity} />
              <ServerCard fallback={server} />
              <VibeCodingCard fallback={vibeCoding} />
            </div>

            <PlaystationBlock
              trophies={trophies}
              playing={playing}
              playingNow={playingNow}
            />

            <div id="watching" className="mt-6 scroll-mt-28 border-t border-line pt-5">
              <div className="mb-3 flex items-baseline justify-between">
                <h3 className="text-sm font-medium">最近在看</h3>
                <span className="label-mono text-muted-foreground">Emby</span>
              </div>
              <WatchingRow fallback={watching} nowFallback={nowWatching} />
            </div>
          </Section>
        </div>
      </main>

      <Footer />
    </>
  );
}
