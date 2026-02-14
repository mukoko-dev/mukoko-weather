"use client";

import { useSyncExternalStore } from "react";
import { Area, CartesianGrid, XAxis, YAxis, Bar, Line, ComposedChart } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { HourlyWeather } from "@/lib/weather";

interface Props {
  hourly: HourlyWeather;
}

export interface HourlyDataPoint {
  label: string;
  temp: number;
  feelsLike: number;
  rain: number;
}

/** Prepare 24-hour data slice starting from the current hour */
export function prepareHourlyData(hourly: HourlyWeather): HourlyDataPoint[] {
  const now = new Date();
  const currentHour = now.getHours();
  const startIndex = hourly.time.findIndex(
    (t) =>
      new Date(t).getHours() >= currentHour &&
      new Date(t).getDate() === now.getDate(),
  );
  const start = startIndex >= 0 ? startIndex : 0;

  const points: HourlyDataPoint[] = [];
  for (let i = 0; i < 24 && start + i < hourly.time.length; i++) {
    const idx = start + i;
    const date = new Date(hourly.time[idx]);
    points.push({
      label:
        i === 0
          ? "Now"
          : date.toLocaleTimeString("en-ZW", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            }),
      temp: Math.round(hourly.temperature_2m[idx]),
      feelsLike: Math.round(hourly.apparent_temperature[idx]),
      rain: hourly.precipitation_probability[idx],
    });
  }
  return points;
}

const chartConfig = {
  temp: {
    label: "Temperature",
    color: "var(--chart-1)",
  },
  feelsLike: {
    label: "Feels Like",
    color: "var(--chart-3)",
  },
  rain: {
    label: "Rain %",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig;

const subscribe = () => () => {};
const getSnapshot = () => true;
const getServerSnapshot = () => false;

export function HourlyChart({ hourly }: Props) {
  // Defer chart rendering to client-only to prevent hydration mismatch.
  // prepareHourlyData uses new Date() which differs between server and client,
  // producing different SVG output that React 19 cannot reconcile.
  const hydrated = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  if (!hydrated) {
    return (
      <div className="mt-4 mb-2 aspect-[16/5] w-full animate-pulse rounded bg-text-tertiary/10" />
    );
  }

  const data = prepareHourlyData(hourly);
  if (data.length < 2) return null;

  const allTemps = data.flatMap((d) => [d.temp, d.feelsLike]);
  const minTemp = Math.min(...allTemps) - 2;
  const maxTemp = Math.max(...allTemps) + 2;

  return (
    <div className="mt-4 mb-2">
      <ChartContainer config={chartConfig} className="aspect-[16/5] w-full">
        <ComposedChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -20 }}>
          <defs>
            <linearGradient id="hourlyTempGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-temp)" stopOpacity={0.3} />
              <stop offset="100%" stopColor="var(--color-temp)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            vertical={false}
            stroke="var(--color-text-tertiary)"
            strokeOpacity={0.15}
          />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            fontSize={11}
            interval={2}
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
                formatter={(value, name) =>
                  name === "rain" ? `${value}%` : `${value}°C`
                }
              />
            }
          />
          <Bar
            dataKey="rain"
            fill="var(--color-rain)"
            fillOpacity={0.35}
            radius={[2, 2, 0, 0]}
            yAxisId="rain"
          />
          <YAxis yAxisId="rain" domain={[0, 100]} hide />
          <Area
            type="monotone"
            dataKey="temp"
            stroke="var(--color-temp)"
            strokeWidth={2.5}
            fill="url(#hourlyTempGradient)"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2 }}
          />
          <Line
            type="monotone"
            dataKey="feelsLike"
            stroke="var(--color-feelsLike)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={false}
            activeDot={{ r: 3, strokeWidth: 1 }}
          />
        </ComposedChart>
      </ChartContainer>
    </div>
  );
}
