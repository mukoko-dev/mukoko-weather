"use client";

import { TimeSeriesChart, type SeriesConfig } from "./TimeSeriesChart";

interface GDDChartProps {
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
  { key: "gddMaize", label: "Maize/Soybean (10–30°C)", color: "var(--color-mineral-malachite)", fill: true, opacity: 0.15 },
  { key: "gddSorghum", label: "Sorghum (8–30°C)", color: "var(--chart-3)", dashed: true },
  { key: "gddPotato", label: "Potatoes (3–25°C)", color: "var(--chart-4)", dashed: true },
];

const Y_AXES = { y: { min: 0, format: (v: number) => `${v}` } };

/**
 * Growing Degree Days (GDD) trend chart — shows crop growth potential over time.
 * Each line represents a different crop's GDD base temperature.
 * Higher GDD = more growth potential for that crop.
 * Used by HistoryDashboard insights section (farming category).
 */
export function GDDChart({
  data,
  labelKey = "date",
  aspect = "aspect-[16/5]",
  showDots,
  tooltipTitle,
  xTickFormat,
  maxTicksLimit = 10,
}: GDDChartProps) {
  return (
    <TimeSeriesChart
      data={data}
      labelKey={labelKey}
      series={SERIES}
      yAxes={Y_AXES}
      tooltipLabel={(label, value) => `${label}: ${value.toFixed(1)}`}
      tooltipTitle={tooltipTitle}
      xTickFormat={xTickFormat}
      maxTicksLimit={maxTicksLimit}
      aspect={aspect}
      showDots={showDots}
    />
  );
}
