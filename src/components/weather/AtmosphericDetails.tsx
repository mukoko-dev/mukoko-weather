"use client";

import type { HourlyWeather } from "@/lib/weather";
import { HumidityCloudChart } from "@/components/weather/charts/HumidityCloudChart";
import { WindSpeedChart } from "@/components/weather/charts/WindSpeedChart";
import { PressureChart } from "@/components/weather/charts/PressureChart";
import { UVIndexChart } from "@/components/weather/charts/UVIndexChart";

interface Props {
  hourly: HourlyWeather;
}

interface AtmosphericDataPoint {
  label: string;
  humidity: number;
  cloudCover: number;
  pressure: number;
  windSpeed: number;
  windGusts: number;
  uvIndex: number;
}

/** Prepare 24-hour atmospheric data slice starting from the current hour */
export function prepareAtmosphericData(hourly: HourlyWeather): AtmosphericDataPoint[] {
  const now = new Date();
  const currentHour = now.getHours();
  const startIndex = hourly.time.findIndex(
    (t) =>
      new Date(t).getHours() >= currentHour &&
      new Date(t).getDate() === now.getDate(),
  );
  const start = startIndex >= 0 ? startIndex : 0;

  const points: AtmosphericDataPoint[] = [];
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
      humidity: hourly.relative_humidity_2m[idx],
      cloudCover: hourly.cloud_cover[idx],
      pressure: Math.round(hourly.surface_pressure[idx]),
      windSpeed: Math.round(hourly.wind_speed_10m[idx]),
      windGusts: Math.round(hourly.wind_gusts_10m[idx]),
      uvIndex: hourly.uv_index[idx],
    });
  }
  return points;
}

export function AtmosphericDetails({ hourly }: Props) {
  const data = prepareAtmosphericData(hourly);
  if (data.length < 2) return null;

  return (
    <section aria-labelledby="atmospheric-details-heading">
      <div className="rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm sm:p-6">
        <h2 id="atmospheric-details-heading" className="text-lg font-semibold text-text-primary font-heading">
          Atmospheric Details
        </h2>
        <p className="mt-1 text-sm text-text-tertiary">24-hour hourly trends</p>

        <div className="mt-4 space-y-6">
          <div>
            <h3 className="mb-2 text-sm font-medium text-text-secondary">Humidity & Cloud Cover</h3>
            <HumidityCloudChart data={data} labelKey="label" />
          </div>

          <div>
            <h3 className="mb-2 text-sm font-medium text-text-secondary">Wind Speed & Gusts</h3>
            <WindSpeedChart data={data} labelKey="label" />
          </div>

          <div>
            <h3 className="mb-2 text-sm font-medium text-text-secondary">Barometric Pressure</h3>
            <PressureChart data={data} labelKey="label" />
          </div>

          <div>
            <h3 className="mb-2 text-sm font-medium text-text-secondary">UV Index</h3>
            <UVIndexChart data={data} labelKey="label" />
          </div>
        </div>
      </div>
    </section>
  );
}
