"use client";

import type { AgriChartRow } from "@/lib/agriculture";
import { TimeSeriesChart, type SeriesConfig } from "./TimeSeriesChart";

interface RainEtChartProps {
  data: AgriChartRow[];
  labelKey?: string;
  aspect?: string;
  maxTicksLimit?: number;
}

const SERIES: SeriesConfig[] = [
  {
    key: "rainMm",
    label: "Rain (mm)",
    color: "var(--color-rain)",
    type: "bar",
    opacity: 0.6,
    order: 2,
  },
  {
    key: "et0Mm",
    label: "Crop water use, ET₀ (mm)",
    color: "var(--color-mineral-terracotta)",
    order: 1,
  },
];

const Y_AXES = { y: { min: 0, format: (v: number) => `${v} mm` } };

/**
 * Daily rain (bars) against FAO-56 reference evapotranspiration (line), both
 * in mm, on one axis so the gap reads directly as the water balance.
 * Used by the agriculture insights page.
 */
export function RainEtChart({
  data,
  labelKey = "date",
  aspect = "aspect-[16/7] sm:aspect-[16/5]",
  maxTicksLimit = 8,
}: RainEtChartProps) {
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
