"use client";

import { TimeSeriesChart, type SeriesConfig } from "./TimeSeriesChart";

interface HeatStressChartProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>[];
  labelKey?: string;
  aspect?: string;
  showDots?: boolean;
  tooltipTitle?: (label: string) => string;
  xTickFormat?: (label: string, index: number) => string;
  maxTicksLimit?: number;
}

const SERIES: SeriesConfig[] = [
  { key: "heatStress", label: "Heat Stress Index", color: "var(--chart-3)", type: "bar", opacity: 0.6 },
];

const Y_AXES = { y: { min: 0, format: (v: number) => `${v}` } };

/**
 * Heat stress index trend chart — shows safety conditions for mining & sports.
 * Index >= 24 = moderate, >= 28 = severe, >= 30 = extreme.
 * Used by HistoryDashboard insights section.
 */
export function HeatStressChart({
  data,
  labelKey = "date",
  aspect = "aspect-[16/5]",
  showDots,
  tooltipTitle,
  xTickFormat,
  maxTicksLimit = 10,
}: HeatStressChartProps) {
  return (
    <TimeSeriesChart
      data={data}
      labelKey={labelKey}
      series={SERIES}
      yAxes={Y_AXES}
      tooltipLabel={(_label, value) => `Index: ${value}`}
      tooltipTitle={tooltipTitle}
      xTickFormat={xTickFormat}
      maxTicksLimit={maxTicksLimit}
      aspect={aspect}
      showDots={showDots}
    />
  );
}
