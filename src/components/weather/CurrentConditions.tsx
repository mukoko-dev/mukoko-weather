"use client";

import { useState, useEffect } from "react";
import { WeatherIcon, WindIcon, DropletIcon, ThermometerIcon, EyeIcon, GaugeIcon, ShareIcon } from "@/lib/weather-icons";
import { weatherCodeToInfo, windDirection, uvLevel, type CurrentWeather, type DailyWeather } from "@/lib/weather";

const BASE_URL = "https://weather.mukoko.com";

interface Props {
  current: CurrentWeather;
  locationName: string;
  daily?: DailyWeather;
  slug?: string;
}

export function CurrentConditions({ current, locationName, daily, slug }: Props) {
  const info = weatherCodeToInfo(current.weather_code);
  const uv = uvLevel(current.uv_index);
  const wind = windDirection(current.wind_direction_10m);
  const todayHigh = daily ? Math.round(daily.temperature_2m_max[0]) : null;
  const todayLow = daily ? Math.round(daily.temperature_2m_min[0]) : null;
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  useEffect(() => {
    if (!copyFailed) return;
    const t = setTimeout(() => setCopyFailed(false), 2000);
    return () => clearTimeout(t);
  }, [copyFailed]);

  function handleShare() {
    const url = slug ? `${BASE_URL}/${slug}` : window.location.href;
    const shareData = {
      title: `${locationName} Weather`,
      text: `Check the weather in ${locationName} on mukoko weather`,
      url,
    };
    if (typeof navigator !== "undefined" && navigator.share) {
      navigator.share(shareData).catch(() => undefined);
    } else {
      navigator.clipboard.writeText(url).then(() => {
        setCopied(true);
      }).catch(() => {
        setCopyFailed(true);
      });
    }
  }

  return (
    <section aria-labelledby="current-conditions-heading">
      <div className="rounded-[var(--radius-card)] border border-primary/25 bg-surface-card p-5 shadow-sm sm:p-6">
        <h2 id="current-conditions-heading" className="sr-only">
          Current weather conditions in {locationName}
        </h2>
        {/* Main temperature display */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-base font-medium text-text-secondary">{locationName}</p>
            <div className="mt-1 flex items-baseline gap-1">
              <span className="font-mono text-7xl font-bold tracking-tighter text-text-primary sm:text-8xl" aria-label={`${Math.round(current.temperature_2m)} degrees Celsius`}>
                {Math.round(current.temperature_2m)}
              </span>
              <span className="font-sans text-3xl font-light text-text-tertiary" aria-hidden="true">°</span>
            </div>
            <p className="mt-1 text-lg font-semibold text-text-primary">{info.label}</p>
            <p className="mt-1 text-base text-text-secondary">
              Feels like {Math.round(current.apparent_temperature)}°C
              {todayHigh !== null && todayLow !== null && (
                <span className="ml-1">
                  · High {todayHigh}° Low {todayLow}°
                </span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <WeatherIcon
              icon={current.is_day ? info.icon : "moon"}
              size={80}
              className="text-primary"
            />
            <button
              type="button"
              onClick={handleShare}
              aria-label={`Share weather for ${locationName}`}
              className="press-scale flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-[var(--radius-input)] bg-surface-base px-3 text-base text-text-secondary transition-colors hover:bg-surface-elevated hover:text-text-primary"
            >
              <ShareIcon size={16} aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">
                {copied ? "Copied!" : copyFailed ? "Copy failed" : "Share"}
              </span>
            </button>
          </div>
        </div>

        {/* Quick stats grid */}
        <div className="stagger-children mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 sm:gap-5" role="list" aria-label="Weather statistics">
          <QuickStat
            icon={<DropletIcon size={18} />}
            label="Humidity"
            value={`${current.relative_humidity_2m}%`}
          />
          <QuickStat
            icon={<WindIcon size={18} />}
            label="Wind"
            value={`${Math.round(current.wind_speed_10m)} km/h ${wind}`}
          />
          <QuickStat
            icon={<WindIcon size={18} />}
            label="Wind Gusts"
            value={`${Math.round(current.wind_gusts_10m)} km/h`}
          />
          <QuickStat
            icon={<GaugeIcon size={18} />}
            label="UV Index"
            value={`${current.uv_index} — ${uv.label}`}
          />
          <QuickStat
            icon={<ThermometerIcon size={18} />}
            label="Pressure"
            value={`${Math.round(current.surface_pressure)} hPa`}
          />
          <QuickStat
            icon={<EyeIcon size={18} />}
            label="Cloud Cover"
            value={`${current.cloud_cover}%`}
          />
          <QuickStat
            icon={<DropletIcon size={18} />}
            label="Precipitation"
            value={`${current.precipitation} mm`}
          />
          {todayHigh !== null && todayLow !== null && daily && (
            <QuickStat
              icon={<ThermometerIcon size={18} />}
              label="Feels Like"
              value={`${Math.round(daily.apparent_temperature_max[0])}° / ${Math.round(daily.apparent_temperature_min[0])}°`}
            />
          )}
        </div>
      </div>
    </section>
  );
}

function QuickStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div role="listitem" className="flex min-w-0 items-center gap-3 rounded-[var(--radius-input)] bg-surface-base p-4">
      <span className="shrink-0 text-text-tertiary" aria-hidden="true">{icon}</span>
      <div className="min-w-0">
        <p className="text-base text-text-tertiary">{label}</p>
        <p className="text-base font-medium text-text-primary" aria-label={`${label}: ${value}`}>{value}</p>
      </div>
    </div>
  );
}
