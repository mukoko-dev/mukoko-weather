"use client";

import { useMemo } from "react";
import { TimeSeriesChart, type SeriesConfig } from "./TimeSeriesChart";

interface WindSpeedChartProps {
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
  { key: "windSpeed", label: "Wind Speed", color: "var(--chart-1)", fill: true },
  { key: "windGusts", label: "Wind Gusts", color: "var(--chart-4)", dashed: true },
];

/**
 * Wind speed area + gusts dashed line chart.
 * Used by AtmosphericDetails and HistoryDashboard.
 */
export function WindSpeedChart({
  data,
  labelKey = "label",
  aspect,
  showDots,
  tooltipTitle,
  xTickFormat,
  maxTicksLimit,
}: WindSpeedChartProps) {
  const yAxes = useMemo(() => {
    const allWind = data.flatMap((d) => [Number(d.windSpeed) || 0, Number(d.windGusts) || 0]);
    const maxWind = (allWind.length > 0 ? Math.max(...allWind) : 20) + 5;
    return { y: { min: 0, max: maxWind } };
  }, [data]);

  return (
    <TimeSeriesChart
      data={data}
      labelKey={labelKey}
      series={SERIES}
      yAxes={yAxes}
      tooltipLabel={(label, value) => `${label}: ${value} km/h`}
      tooltipTitle={tooltipTitle}
      xTickFormat={xTickFormat}
      maxTicksLimit={maxTicksLimit}
      aspect={aspect}
      showDots={showDots}
    />
  );
}
