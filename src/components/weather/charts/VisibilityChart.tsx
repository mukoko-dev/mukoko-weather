"use client";

import { TimeSeriesChart, type SeriesConfig } from "./TimeSeriesChart";

interface VisibilityChartProps {
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
  { key: "visibility", label: "Visibility", color: "var(--chart-1)", fill: true, opacity: 0.12 },
];

const Y_AXES = { y: { min: 0, format: (v: number) => `${v} km` } };

/**
 * Visibility trend chart — shows conditions for travel and photography.
 * <1 km = very poor, <5 km = reduced, >10 km = excellent.
 * Used by HistoryDashboard insights section.
 */
export function VisibilityChart({
  data,
  labelKey = "date",
  aspect = "aspect-[16/5]",
  showDots,
  tooltipTitle,
  xTickFormat,
  maxTicksLimit = 10,
}: VisibilityChartProps) {
  return (
    <TimeSeriesChart
      data={data}
      labelKey={labelKey}
      series={SERIES}
      yAxes={Y_AXES}
      tooltipLabel={(_label, value) => `${value} km`}
      tooltipTitle={tooltipTitle}
      xTickFormat={xTickFormat}
      maxTicksLimit={maxTicksLimit}
      aspect={aspect}
      showDots={showDots}
    />
  );
}
