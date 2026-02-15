"use client";

import { TimeSeriesChart, type SeriesConfig } from "./TimeSeriesChart";

interface PrecipitationChartProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>[];
  labelKey?: string;
  aspect?: string;
  tooltipTitle?: (label: string) => string;
  xTickFormat?: (label: string, index: number) => string;
  maxTicksLimit?: number;
}

const SERIES: SeriesConfig[] = [
  { key: "precipitation", label: "Rainfall (mm)", color: "var(--color-rain)", type: "bar", opacity: 0.6, yAxisID: "mm", order: 2 },
  { key: "rainProbability", label: "Probability (%)", color: "var(--chart-5)", dashed: true, yAxisID: "pct", order: 1 },
];

const Y_AXES = {
  mm: { position: "left" as const, format: (v: number) => `${v} mm` },
  pct: { position: "right" as const, min: 0, max: 100, format: (v: number) => `${v}%` },
};

/**
 * Precipitation chart: rainfall bars (mm) + probability dashed line (%).
 * Dual Y axes for different units.
 * Used by HistoryDashboard.
 */
export function PrecipitationChart({
  data,
  labelKey = "date",
  aspect,
  tooltipTitle,
  xTickFormat,
  maxTicksLimit = 10,
}: PrecipitationChartProps) {
  return (
    <TimeSeriesChart
      data={data}
      labelKey={labelKey}
      series={SERIES}
      yAxes={Y_AXES}
      tooltipLabel={(label, value) =>
        label.includes("mm") || label.includes("Rainfall") ? `${value} mm` : `${value}%`
      }
      tooltipTitle={tooltipTitle}
      xTickFormat={xTickFormat}
      maxTicksLimit={maxTicksLimit}
      aspect={aspect}
    />
  );
}
