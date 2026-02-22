"use client";

import { usePathname } from "next/navigation";
import type { CurrentWeather } from "@/lib/weather";
import { SectionHeader } from "@/components/ui/section-header";
import { windDirection, uvLevel } from "@/lib/weather";
import { humidityLabel, pressureLabel, cloudLabel, feelsLikeContext } from "@/lib/weather-labels";
import {
  DropletIcon,
  CloudIcon,
  WindIcon,
  GaugeIcon,
  SunIcon,
  EyeIcon,
} from "@/lib/weather-icons";
import { MetricCard, type GaugeConfig } from "./MetricCard";

interface Props {
  current: CurrentWeather;
}

// ── Gauge configurations ─────────────────────────────────────────────────────
// Each metric gets a radial arc gauge showing where its value falls
// on a severity-colored scale. The arc spans 270° (open at bottom).

/** UV Index: 0–11+ scale */
export function uvGauge(uv: number): GaugeConfig {
  const percent = Math.min((uv / 11) * 100, 100);
  if (uv <= 2) return { percent, strokeClass: "stroke-severity-low" };
  if (uv <= 5) return { percent, strokeClass: "stroke-severity-moderate" };
  if (uv <= 7) return { percent, strokeClass: "stroke-severity-high" };
  if (uv <= 10) return { percent, strokeClass: "stroke-severity-severe" };
  return { percent, strokeClass: "stroke-severity-extreme" };
}

/** Humidity: 0–100%, comfort zone is 30–60% */
export function humidityGauge(h: number): GaugeConfig {
  const percent = Math.min(h, 100);
  if (h < 30) return { percent, strokeClass: "stroke-severity-moderate" };
  if (h <= 60) return { percent, strokeClass: "stroke-severity-low" };
  if (h <= 80) return { percent, strokeClass: "stroke-severity-moderate" };
  return { percent, strokeClass: "stroke-severity-high" };
}

/** Cloud cover: 0–100% */
export function cloudGauge(c: number): GaugeConfig {
  const percent = Math.min(c, 100);
  if (c <= 50) return { percent, strokeClass: "stroke-severity-low" };
  if (c <= 75) return { percent, strokeClass: "stroke-severity-moderate" };
  return { percent, strokeClass: "stroke-severity-high" };
}

/** Wind speed: 0–80+ km/h scale */
export function windGauge(speed: number): GaugeConfig {
  const percent = Math.min((speed / 80) * 100, 100);
  if (speed <= 19) return { percent, strokeClass: "stroke-severity-low" };
  if (speed <= 38) return { percent, strokeClass: "stroke-severity-moderate" };
  if (speed <= 61) return { percent, strokeClass: "stroke-severity-high" };
  return { percent, strokeClass: "stroke-severity-severe" };
}

/** Pressure: 980–1040 hPa range mapped to gauge */
export function pressureGauge(p: number): GaugeConfig {
  const min = 980;
  const max = 1040;
  const clamped = Math.max(min, Math.min(p, max));
  const percent = ((clamped - min) / (max - min)) * 100;
  if (p < 1000) return { percent, strokeClass: "stroke-severity-moderate" };
  if (p <= 1020) return { percent, strokeClass: "stroke-severity-low" };
  return { percent, strokeClass: "stroke-severity-moderate" };
}

/** Feels-like difference from actual */
export function feelsLikeGauge(feelsLike: number, actual: number): GaugeConfig {
  const diff = Math.abs(feelsLike - actual);
  const percent = Math.min((diff / 15) * 100, 100);
  if (diff <= 2) return { percent: Math.max(percent, 8), strokeClass: "stroke-severity-low" };
  if (diff <= 5) return { percent, strokeClass: "stroke-severity-moderate" };
  if (diff <= 10) return { percent, strokeClass: "stroke-severity-high" };
  return { percent, strokeClass: "stroke-severity-severe" };
}

// ── Main component ───────────────────────────────────────────────────────────

export function AtmosphericSummary({ current }: Props) {
  const pathname = usePathname();
  const locationSlug = pathname?.split("/")[1] || "harare";
  const uv = uvLevel(current.uv_index);
  const wind = Math.round(current.wind_speed_10m);
  const gusts = Math.round(current.wind_gusts_10m);

  return (
    <section aria-labelledby="atmospheric-heading">
      <SectionHeader
        headingId="atmospheric-heading"
        title="Conditions"
        action={{ label: "24h trends →", href: `/${locationSlug}/atmosphere` }}
        className="mb-3"
      />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <MetricCard
          icon={<DropletIcon size={16} />}
          label="Humidity"
          value={`${current.relative_humidity_2m}%`}
          context={humidityLabel(current.relative_humidity_2m)}
          gauge={humidityGauge(current.relative_humidity_2m)}
        />
        <MetricCard
          icon={<CloudIcon size={16} />}
          label="Cloud Cover"
          value={`${current.cloud_cover}%`}
          context={cloudLabel(current.cloud_cover)}
          gauge={cloudGauge(current.cloud_cover)}
        />
        <MetricCard
          icon={<WindIcon size={16} />}
          label="Wind"
          value={`${wind}`}
          context={`Gusts ${gusts} · ${windDirection(current.wind_direction_10m)}`}
          gauge={windGauge(wind)}
        />
        <MetricCard
          icon={<GaugeIcon size={16} />}
          label="Pressure"
          value={`${Math.round(current.surface_pressure)}`}
          context={pressureLabel(current.surface_pressure)}
          gauge={pressureGauge(current.surface_pressure)}
        />
        <MetricCard
          icon={<SunIcon size={16} />}
          label="UV Index"
          value={`${Math.round(current.uv_index)}`}
          context={uv.label}
          contextColor={uv.color}
          gauge={uvGauge(current.uv_index)}
        />
        <MetricCard
          icon={<EyeIcon size={16} />}
          label="Feels Like"
          value={`${Math.round(current.apparent_temperature)}°`}
          context={feelsLikeContext(current.apparent_temperature, current.temperature_2m)}
          gauge={feelsLikeGauge(current.apparent_temperature, current.temperature_2m)}
        />
      </div>
    </section>
  );
}
