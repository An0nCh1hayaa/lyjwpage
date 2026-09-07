"use client";

import { useMemo, useState } from "react";

import {
  HeatmapGrid,
  HeatmapTooltip,
  cellAnchor,
  useHeatmapOpen,
  type CellAnchor,
} from "@/components/live/heatmap-hover";
import { useStatus } from "@/hooks/use-status";
import { groupWeeks } from "@/lib/github-chart-compact";
import { isHeatmapFuture } from "@/lib/heatmap-window";
import { VIBECODING_YEAR_PATH } from "@/lib/paths";
import type { GithubChartDay, StatusResponse, VibeCodingYearPayload } from "@/lib/types";
import {
  YEAR_MIX_SHOW,
  compactTokens,
  expandYearDays,
  formatTokenLabel,
  indexYearMix,
  tokenScores,
  type YearModelShare,
} from "@/lib/vibecoding-year";
import { cn } from "@/lib/utils";

/** 云端可能回填旧日，长间隔或切回焦点时都刷新完整的 53 周。 */
const REFRESH_MS = 6 * 60 * 60_000;

/** 蓝留给 GitHub 贡献图。这边四档绿写在 .vibe-year-chart 的 CSS 变量里。 */
const FILLS = [
  "var(--muted)",
  "var(--year-score-1)",
  "var(--year-score-2)",
  "var(--year-score-3)",
  "var(--year-score-4)",
] as const;

type HoveredCell = {
  date: string;
  tokens: number;
  models: YearModelShare[];
  anchor: CellAnchor;
};

function toWeeks(origin: string, days: number[], through: string): GithubChartDay[][] {
  const scores = tokenScores(days);
  const expanded = expandYearDays(origin, days);
  return groupWeeks(
    expanded.flatMap((day, index) => {
      // 信封固定 53 周填到本周六；GitHub 图只画到今天，这边对齐，不给未来留空格。
      if (isHeatmapFuture(day.date, through)) return [];
      return [
        {
          date: day.date,
          weekday: day.weekday,
          count: day.tokens,
          score: scores[index] ?? 0,
          label: formatTokenLabel(day.date, day.tokens),
        },
      ];
    }),
  );
}

function mixByDate(origin: string, days: number[], models: string[], mix: number[][]) {
  const byOffset = indexYearMix(models, mix);
  const byDate = new Map<string, YearModelShare[]>();
  expandYearDays(origin, days).forEach((day, index) => {
    const parts = byOffset.get(index);
    if (parts?.length) byDate.set(day.date, parts);
  });
  return byDate;
}

function sharePercent(tokens: number, total: number) {
  if (total <= 0 || tokens <= 0) return 0;
  return Math.min(100, (tokens / total) * 100);
}

function formatPercent(tokens: number, total: number) {
  const percent = sharePercent(tokens, total);
  if (percent > 0 && percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
}

function MixBreakdown({
  tokens,
  models,
}: {
  tokens: number;
  models: YearModelShare[];
}) {
  const rows = models.slice(0, YEAR_MIX_SHOW);
  if (rows.length === 0) return null;
  return (
    <div className="mt-2 min-w-0 border-t border-line pt-1.5">
      <ul className="grid min-w-0 gap-1.5">
        {rows.map((row) => (
          <li key={row.model} className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[10px]" title={row.model}>
                {row.model}
              </span>
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                {compactTokens(row.tokens)}
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <div className="h-1 min-w-0 flex-1 bg-muted">
                <div
                  className="h-full bg-live"
                  style={{ width: `${sharePercent(row.tokens, tokens)}%` }}
                />
              </div>
              <span className="w-7 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                {formatPercent(row.tokens, tokens)}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function VibeYearChart({
  fallback,
  className,
}: {
  fallback: StatusResponse<VibeCodingYearPayload>;
  className?: string;
}) {
  const { data } = useStatus<VibeCodingYearPayload>(VIBECODING_YEAR_PATH, REFRESH_MS, {
    fallback,
    // 首屏已经烧进去，挂载不再回源。切回标签页时拉一次，长轮询仍作兜底。
    revalidateOnMount: false,
    revalidateOnFocus: true,
  });
  const [lastDrawn, setLastDrawn] = useState(fallback.ok ? fallback.data : null);
  if (data?.days.length && data !== lastDrawn) setLastDrawn(data);
  const snapshot = data?.days.length ? data : lastDrawn;
  const { svgRef, shown, hotDate, previewCell, clearPreview, togglePin } =
    useHeatmapOpen<HoveredCell>();

  const weeks = useMemo(() => {
    if (!snapshot) return null;
    /**
     * 窗尾切到源站的今天，**不是切到 `pushedAt`**：那是上报器最后一次推送，
     * Mac 停一天，今天那格就跟着少一格，隔壁 GitHub 那张图却照常画到今天，
     * 两张图当场错开一列。见 VibeCodingYearPayload.todayAtSource。
     */
    return toWeeks(snapshot.origin, snapshot.days, snapshot.todayAtSource);
  }, [snapshot]);

  const modelsByDate = useMemo(() => {
    if (!snapshot) return new Map<string, YearModelShare[]>();
    return mixByDate(
      snapshot.origin,
      snapshot.days,
      snapshot.models ?? [],
      snapshot.mix ?? [],
    );
  }, [snapshot]);

  if (!weeks?.length) return null;

  const cellOf = (day: GithubChartDay, target: Element): HoveredCell => ({
    date: day.date,
    tokens: day.count,
    models: modelsByDate.get(day.date) ?? [],
    anchor: cellAnchor(target),
  });

  return (
    <div className={cn("github-chart vibe-year-chart", className)}>
      <HeatmapGrid
        svgRef={svgRef}
        weeks={weeks}
        fills={FILLS}
        hotDate={hotDate}
        label="Vibe Coding token heatmap"
        onCellPreview={(day, target) => previewCell(cellOf(day, target))}
        onCellClear={clearPreview}
        onCellToggle={(day, target) => togglePin(cellOf(day, target))}
      />
      {shown && (
        <HeatmapTooltip
          date={shown.date}
          value={compactTokens(shown.tokens)}
          unit="Token"
          anchor={shown.anchor}
        >
          <MixBreakdown tokens={shown.tokens} models={shown.models} />
        </HeatmapTooltip>
      )}
    </div>
  );
}
