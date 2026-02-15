"use client";

import { useMemo } from "react";
import { TimeSeriesChart, type SeriesConfig } from "./TimeSeriesChart";

interface PressureChartProps {
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
  { key: "pressure", label: "Pressure", color: "var(--chart-3)" },
];

/**
 * Barometric pressure line chart with auto-scaled Y axis.
 * Used by AtmosphericDetails and HistoryDashboard.
 */
export function PressureChart({
  data,
  labelKey = "label",
  aspect,
  showDots,
  tooltipTitle,
  xTickFormat,
  maxTicksLimit,
}: PressureChartProps) {
  const yAxes = useMemo(() => {
    const pressures = data.map((d) => Number(d.pressure) || 1013);
    const minP = (pressures.length > 0 ? Math.min(...pressures) : 1010) - 2;
    const maxP = (pressures.length > 0 ? Math.max(...pressures) : 1020) + 2;
    return { y: { min: minP, max: maxP } };
  }, [data]);

  return (
    <TimeSeriesChart
      data={data}
      labelKey={labelKey}
      series={SERIES}
      yAxes={yAxes}
      tooltipLabel={(_label, value) => `${value} hPa`}
      tooltipTitle={tooltipTitle}
      xTickFormat={xTickFormat}
      maxTicksLimit={maxTicksLimit}
      aspect={aspect}
      showDots={showDots}
    />
  );
}
