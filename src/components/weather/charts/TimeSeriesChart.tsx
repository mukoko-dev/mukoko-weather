"use client";

import { useMemo } from "react";
import { CanvasChart, resolveColor, type ChartConfig } from "@/components/ui/chart";
import type { ChartData, ChartOptions } from "chart.js";

/**
 * Safely apply alpha to a resolved color string.
 * Handles hex (#RGB, #RRGGBB, #RRGGBBAA) and rgb/rgba formats.
 * Falls back to appending hex alpha for unknown formats.
 */
function hexWithAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  // rgb(r, g, b) or rgba(r, g, b, a)
  const rgbMatch = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (rgbMatch) {
    return `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${a})`;
  }
  // Hex: strip existing alpha, add new one
  const hex = color.replace(/^#/, "");
  const base = hex.length === 8 ? hex.slice(0, 6) : hex.length === 4 ? hex.slice(0, 3) : hex;
  return `#${base}${Math.round(a * 255).toString(16).padStart(2, "0")}`;
}

export interface SeriesConfig {
  key: string;
  label: string;
  color: string;
  type?: "line" | "bar";
  fill?: boolean;
  dashed?: boolean;
  yAxisID?: string;
  order?: number;
  opacity?: number;
  showDots?: boolean;
}

export interface TimeSeriesChartProps {
  /** Data points — must include a label field + numeric series fields */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>[];
  /** Which field on each data point provides the x-axis label */
  labelKey: string;
  /** Series definitions — each draws a line, area, or bar */
  series: SeriesConfig[];
  /** Y-axis configs (keyed by yAxisID or "y" for default) */
  yAxes?: Record<string, {
    min?: number;
    max?: number;
    position?: "left" | "right";
    display?: boolean;
    format?: (v: number) => string;
  }>;
  /** Custom tooltip label formatter */
  tooltipLabel?: (datasetLabel: string, value: number) => string;
  /** Custom tooltip title formatter (receives the raw label value) */
  tooltipTitle?: (label: string) => string;
  /** Custom x-axis tick formatter (receives the raw label value and index) */
  xTickFormat?: (label: string, index: number) => string;
  /** Maximum number of x-axis ticks (default 8) */
  maxTicksLimit?: number;
  /** Aspect ratio class (e.g. "aspect-[16/5]") */
  aspect?: string;
  /** Show dots on data points */
  showDots?: boolean;
}

/**
 * Reusable Canvas-based time series chart.
 *
 * Draws lines, areas, and bars on a single canvas element.
 * Used across all weather dashboards to eliminate duplication.
 *
 * Examples:
 * - Temperature trend: 2 area series + 2 dashed line series
 * - Precipitation: 1 bar series + 1 line series, dual Y axes
 * - Humidity: 1 filled area series
 */
export function TimeSeriesChart({
  data,
  labelKey,
  series,
  yAxes,
  tooltipLabel,
  tooltipTitle,
  xTickFormat,
  maxTicksLimit = 8,
  aspect = "aspect-[2/1] sm:aspect-[16/5]",
  showDots = false,
}: TimeSeriesChartProps) {
  const gridColor = resolveColor("var(--color-text-tertiary)");

  // Resolve all series colors once — used for both config and datasets.
  // Tracked as a dependency so charts re-render on theme change.
  const resolvedSeriesColors = useMemo(
    () => series.map((s) => resolveColor(s.color)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, gridColor], // gridColor changes when theme changes, triggering re-resolve
  );

  const config = useMemo(() => {
    const cfg: ChartConfig = {};
    for (const s of series) {
      cfg[s.key] = { label: s.label, color: s.color };
    }
    return cfg;
  }, [series]);

  const hasMixedTypes = series.some((s) => s.type === "bar") && series.some((s) => !s.type || s.type === "line");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartData: ChartData<any> = useMemo(() => {
    const labels = data.map((d) => d[labelKey]);
    const datasets = series.map((s, idx) => {
      const color = resolvedSeriesColors[idx];
      const isBar = s.type === "bar";
      const dotRadius = (s.showDots ?? showDots) ? 2 : 0;

      if (isBar) {
        return {
          type: "bar" as const,
          label: s.label,
          data: data.map((d) => d[s.key]),
          backgroundColor: hexWithAlpha(color, s.opacity ?? 0.6),
          borderRadius: 2,
          yAxisID: s.yAxisID ?? "y",
          order: s.order ?? 2,
        };
      }

      return {
        type: "line" as const,
        label: s.label,
        data: data.map((d) => d[s.key]),
        borderColor: color,
        backgroundColor: s.fill ? hexWithAlpha(color, s.opacity ?? 0.12) : undefined,
        borderWidth: s.dashed ? 1.5 : 2,
        borderDash: s.dashed ? [4, 3] : undefined,
        fill: s.fill ?? false,
        tension: 0.4,
        pointRadius: s.dashed ? 0 : dotRadius,
        pointHitRadius: 8,
        yAxisID: s.yAxisID ?? "y",
        order: s.order ?? 1,
      };
    });

    return { labels, datasets };
  }, [data, labelKey, series, showDots, resolvedSeriesColors]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartOptions: ChartOptions<any> = useMemo(() => {
    const scales: Record<string, unknown> = {
      x: {
        grid: { display: false },
        ticks: {
          color: gridColor,
          font: { size: 11 },
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...(xTickFormat ? { callback: (_v: any, i: number) => xTickFormat(data[i]?.[labelKey] ?? "", i) } : {}),
        },
        border: { display: false },
      },
    };

    if (yAxes) {
      for (const [id, cfg] of Object.entries(yAxes)) {
        scales[id] = {
          position: cfg.position ?? "left",
          display: cfg.display ?? true,
          min: cfg.min,
          max: cfg.max,
          grid: cfg.position === "right"
            ? { display: false }
            : { color: hexWithAlpha(gridColor, 0.15), drawTicks: false },
          ticks: {
            color: gridColor,
            font: { size: 11 },
            ...(cfg.format ? { callback: (v: string | number) => cfg.format!(Number(v)) } : {}),
          },
          border: { display: false },
        };
      }
    } else {
      scales.y = {
        grid: { color: hexWithAlpha(gridColor, 0.15), drawTicks: false },
        ticks: { color: gridColor, font: { size: 11 } },
        border: { display: false },
      };
    }

    return {
      scales,
      plugins: {
        tooltip: {
          callbacks: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            title: tooltipTitle ? (items: any[]) => tooltipTitle(data[items[0]?.dataIndex ?? 0]?.[labelKey] ?? "") : undefined,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            label: tooltipLabel ? (ctx: any) => tooltipLabel(ctx.dataset.label ?? "", ctx.parsed.y) : undefined,
          },
        },
      },
    };
  }, [data, labelKey, gridColor, yAxes, tooltipLabel, tooltipTitle, xTickFormat, maxTicksLimit]);

  const chartType = hasMixedTypes ? "bar" : (series[0]?.type ?? "line");

  return (
    <CanvasChart
      type={chartType}
      data={chartData}
      options={chartOptions}
      config={config}
      className={`${aspect} w-full`}
    />
  );
}
