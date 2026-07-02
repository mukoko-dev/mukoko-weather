"use client";

import { useState, useEffect } from "react";
import { WeatherIcon, ShareIcon } from "@/lib/weather-icons";
import { weatherCodeToInfo, type CurrentWeather, type DailyWeather } from "@/lib/weather";
import { HeroWeatherBackground } from "@/components/weather/HeroWeatherBackground";

const BASE_URL = "https://weather.mukoko.com";

interface Props {
  current: CurrentWeather;
  locationName: string;
  daily?: DailyWeather;
  slug?: string;
}

export function CurrentConditions({ current, locationName, daily, slug }: Props) {
  const info = weatherCodeToInfo(current.weather_code);
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
      {/* Hero card — the main current-conditions block sits at the very top of the
          page and reads as the visual anchor: oversized temperature, extra padding.
          It also hosts the condition-based animated background. */}
      <div className="baobab relative isolate overflow-hidden p-5 sm:p-7">
        {/* Condition-based animated background (decorative, self-isolating) */}
        <HeroWeatherBackground
          weatherCode={current.weather_code}
          windSpeed={current.wind_speed_10m}
          isDay={current.is_day === 1}
        />
        <h2 id="current-conditions-heading" className="sr-only">
          Current weather conditions in {locationName}
        </h2>
        {/* Main temperature display */}
        <div className="relative z-10 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-lg font-medium text-text-secondary">{locationName}</p>
            <div className="mt-1 flex items-baseline gap-1">
              <span className="font-mono text-7xl font-bold tracking-tighter text-text-primary sm:text-8xl" aria-label={`${Math.round(current.temperature_2m)} degrees Celsius`}>
                {Math.round(current.temperature_2m)}
              </span>
              <span className="font-sans text-4xl font-light text-text-tertiary sm:text-5xl" aria-hidden="true">°</span>
            </div>
            <p className="mt-2 text-xl font-semibold text-text-primary sm:text-2xl">{info.label}</p>
            <p className="mt-1.5 text-lg text-text-secondary">
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
              size={88}
              className="text-primary"
            />
            <button
              type="button"
              onClick={handleShare}
              aria-label={`Share weather for ${locationName}`}
              className="press-scale flex min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)] items-center justify-center gap-1.5 rounded-[var(--radius-input)] bg-surface-base px-3 text-base text-text-secondary transition-colors hover:bg-surface-elevated hover:text-text-primary"
            >
              <ShareIcon size={16} aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">
                {copied ? "Copied!" : copyFailed ? "Copy failed" : "Share"}
              </span>
            </button>
          </div>
        </div>

      </div>
    </section>
  );
}
