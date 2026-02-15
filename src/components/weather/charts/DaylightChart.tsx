"use client";

import { TimeSeriesChart, type SeriesConfig } from "./TimeSeriesChart";

interface DaylightChartProps {
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
  { key: "daylightHours", label: "Daylight", color: "var(--chart-3)", fill: true, opacity: 0.12 },
];

const Y_AXES = { y: { format: (v: number) => `${v}h` } };

/**
 * Daylight hours area chart.
 * Used by HistoryDashboard.
 */
export function DaylightChart({
  data,
  labelKey = "date",
  aspect = "aspect-[16/4]",
  showDots,
  tooltipTitle,
  xTickFormat,
  maxTicksLimit = 10,
}: DaylightChartProps) {
  return (
    <TimeSeriesChart
      data={data}
      labelKey={labelKey}
      series={SERIES}
      yAxes={Y_AXES}
      tooltipLabel={(_label, value) => `${value} hours`}
      tooltipTitle={tooltipTitle}
      xTickFormat={xTickFormat}
      maxTicksLimit={maxTicksLimit}
      aspect={aspect}
      showDots={showDots}
    />
  );
}
