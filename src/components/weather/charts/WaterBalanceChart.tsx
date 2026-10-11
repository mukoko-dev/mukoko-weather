"use client";

import type { AgriChartRow } from "@/lib/agriculture";
import { TimeSeriesChart, type SeriesConfig } from "./TimeSeriesChart";

interface WaterBalanceChartProps {
  data: AgriChartRow[];
  labelKey?: string;
  aspect?: string;
  maxTicksLimit?: number;
}

const SERIES: SeriesConfig[] = [
  {
    key: "cumulativeBalanceMm",
    label: "Running balance (mm)",
    color: "var(--color-mineral-malachite)",
    fill: true,
    opacity: 0.15,
    order: 1,
  },
  {
    key: "balanceMm",
    label: "Daily rain − ET₀ (mm)",
    color: "var(--chart-2)",
    type: "bar",
    opacity: 0.5,
    order: 2,
  },
];

const Y_AXES = { y: { format: (v: number) => `${v} mm` } };

/**
 * Water balance: daily rain minus ET₀ (bars) and its running total (area).
 * Below zero the crop is drawing down soil water; above, rain is recharging it.
 * Used by the agriculture insights page.
 */
export function WaterBalanceChart({
  data,
  labelKey = "date",
  aspect = "aspect-[16/7] sm:aspect-[16/5]",
  maxTicksLimit = 8,
}: WaterBalanceChartProps) {
  return (
    <TimeSeriesChart
      data={data}
      labelKey={labelKey}
      series={SERIES}
      yAxes={Y_AXES}
      tooltipLabel={(label, value) => `${label}: ${value.toFixed(1)}`}
      maxTicksLimit={maxTicksLimit}
      aspect={aspect}
    />
  );
}
