"use client";

import { TimeSeriesChart, type SeriesConfig } from "./TimeSeriesChart";

interface DewPointChartProps {
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
  { key: "dewPoint", label: "Dew Point", color: "var(--chart-2)", fill: true, opacity: 0.15 },
];

/**
 * Dew point trend chart — shows frost/disease risk for farming.
 * Low dew point (<5°C) indicates frost risk; high (>20°C) indicates crop disease risk.
 * Used by HistoryDashboard insights section.
 */
export function DewPointChart({
  data,
  labelKey = "date",
  aspect = "aspect-[16/5]",
  showDots,
  tooltipTitle,
  xTickFormat,
  maxTicksLimit = 10,
}: DewPointChartProps) {
  return (
    <TimeSeriesChart
      data={data}
      labelKey={labelKey}
      series={SERIES}
      tooltipLabel={(_label, value) => `${value}°C`}
      tooltipTitle={tooltipTitle}
      xTickFormat={xTickFormat}
      maxTicksLimit={maxTicksLimit}
      aspect={aspect}
      showDots={showDots}
    />
  );
}
