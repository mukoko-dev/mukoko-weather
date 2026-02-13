"use client";

import { useSyncExternalStore } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis, Line } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { DailyWeather } from "@/lib/weather";

interface Props {
  daily: DailyWeather;
}

export interface DailyDataPoint {
  day: string;
  high: number;
  low: number;
  feelsHigh: number;
  feelsLow: number;
  range: [number, number];
  rain: number;
}

/** Prepare 7-day data for the chart */
export function prepareDailyData(daily: DailyWeather): DailyDataPoint[] {
  return daily.time.map((date, i) => {
    const d = new Date(date);
    const dayName =
      i === 0
        ? "Today"
        : d.toLocaleDateString("en-ZW", { weekday: "short" });
    const high = Math.round(daily.temperature_2m_max[i]);
    const low = Math.round(daily.temperature_2m_min[i]);
    return {
      day: dayName,
      high,
      low,
      feelsHigh: Math.round(daily.apparent_temperature_max[i]),
      feelsLow: Math.round(daily.apparent_temperature_min[i]),
      range: [low, high],
      rain: daily.precipitation_probability_max[i],
    };
  });
}

const chartConfig = {
  high: {
    label: "High",
    color: "var(--chart-1)",
  },
  low: {
    label: "Low",
    color: "var(--chart-2)",
  },
  feelsHigh: {
    label: "Feels High",
    color: "var(--chart-3)",
  },
  feelsLow: {
    label: "Feels Low",
    color: "var(--chart-4)",
  },
} satisfies ChartConfig;

const subscribe = () => () => {};
const getSnapshot = () => true;
const getServerSnapshot = () => false;

export function DailyChart({ daily }: Props) {
  // Defer chart rendering to client-only to prevent hydration mismatch.
  // prepareDailyData uses new Date() and toLocaleDateString which can differ
  // between server and client, producing different SVG output.
  const hydrated = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  if (!hydrated) {
    return (
      <div className="mt-4 mb-2 aspect-[16/7] w-full animate-pulse rounded bg-text-tertiary/10" />
    );
  }

  const data = prepareDailyData(daily);
  if (data.length < 2) return null;

  const allTemps = data.flatMap((d) => [d.high, d.low, d.feelsHigh, d.feelsLow]);
  const minTemp = Math.min(...allTemps) - 2;
  const maxTemp = Math.max(...allTemps) + 2;

  return (
    <div className="mt-4 mb-2">
      <ChartContainer config={chartConfig} className="aspect-[16/7] w-full">
        <AreaChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -20 }}>
          <defs>
            <linearGradient id="dailyHighGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-high)" stopOpacity={0.25} />
              <stop offset="100%" stopColor="var(--color-high)" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="dailyLowGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-low)" stopOpacity={0.15} />
              <stop offset="100%" stopColor="var(--color-low)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            vertical={false}
            stroke="var(--color-text-tertiary)"
            strokeOpacity={0.15}
          />
          <XAxis
            dataKey="day"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            fontSize={11}
            tick={{ fill: "var(--color-text-tertiary)" }}
          />
          <YAxis
            domain={[minTemp, maxTemp]}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => `${v}°`}
            fontSize={11}
            tick={{ fill: "var(--color-text-tertiary)" }}
            width={40}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value, name) => {
                  const labels: Record<string, string> = { high: "High", low: "Low", feelsHigh: "Feels High", feelsLow: "Feels Low" };
                  return `${labels[name as string] ?? name}: ${value}°C`;
                }}
              />
            }
          />
          <Area
            type="monotone"
            dataKey="high"
            stroke="var(--color-high)"
            strokeWidth={2.5}
            fill="url(#dailyHighGradient)"
            dot={{ r: 3, strokeWidth: 2, fill: "var(--color-surface-card)" }}
            activeDot={{ r: 5, strokeWidth: 2 }}
          />
          <Area
            type="monotone"
            dataKey="low"
            stroke="var(--color-low)"
            strokeWidth={2}
            fill="url(#dailyLowGradient)"
            dot={{ r: 3, strokeWidth: 2, fill: "var(--color-surface-card)" }}
            activeDot={{ r: 5, strokeWidth: 2 }}
            strokeDasharray="4 3"
          />
          <Line
            type="monotone"
            dataKey="feelsHigh"
            stroke="var(--color-feelsHigh)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={false}
            activeDot={{ r: 3, strokeWidth: 1 }}
          />
          <Line
            type="monotone"
            dataKey="feelsLow"
            stroke="var(--color-feelsLow)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={false}
            activeDot={{ r: 3, strokeWidth: 1 }}
          />
        </AreaChart>
      </ChartContainer>
    </div>
  );
}
