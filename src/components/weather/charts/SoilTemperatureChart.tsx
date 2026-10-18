"use client";

import type { AgriChartRow } from "@/lib/agriculture";
import { TimeSeriesChart, type SeriesConfig } from "./TimeSeriesChart";

interface SoilTemperatureChartProps {
  data: AgriChartRow[];
  labelKey?: string;
  aspect?: string;
  maxTicksLimit?: number;
}

const SERIES: SeriesConfig[] = [
  { key: "st0", label: "Surface", color: "var(--chart-5)" },
  {
    key: "st6",
    label: "6 cm (seed depth)",
    color: "var(--color-mineral-malachite)",
  },
  { key: "st18", label: "18 cm", color: "var(--chart-2)", dashed: true },
  { key: "st54", label: "54 cm", color: "var(--chart-6)", dashed: true },
];

const Y_AXES = { y: { format: (v: number) => `${v}°C` } };

/**
 * Daily mean soil temperature by depth. Seed depth (6 cm) drives germination;
 * maize needs it warm (about 10–12 °C) to plant. Used by the agriculture
 * insights page.
 */
export function SoilTemperatureChart({
  data,
  labelKey = "date",
  aspect = "aspect-[16/7] sm:aspect-[16/5]",
  maxTicksLimit = 8,
}: SoilTemperatureChartProps) {
  return (
    <TimeSeriesChart
      data={data}
      labelKey={labelKey}
      series={SERIES}
      yAxes={Y_AXES}
      tooltipLabel={(label, value) => `${label}: ${value.toFixed(1)}°C`}
      maxTicksLimit={maxTicksLimit}
      aspect={aspect}
    />
  );
}
