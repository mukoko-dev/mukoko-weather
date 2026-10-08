"use client";

import { useEffect } from "react";
import type { WeatherData } from "@/lib/weather";
import type { AirQualityResponse } from "@/components/weather/AirQualityCard";
import { ChartErrorBoundary } from "@/components/weather/ChartErrorBoundary";
import {
  DisplayAirQuality,
  DisplayClock,
  DisplayDays,
  DisplayHours,
  DisplayNow,
  DisplayOutlook,
  DisplayRadar,
} from "@/components/display/DisplayPanels";
import {
  DISPLAY_REFRESH_MS,
  isAirQuality,
  isDisplayWeather,
  type DisplayTheme,
} from "@/lib/display";
import {
  usePeriodicReload,
  usePolledJson,
  useWakeLock,
} from "@/lib/use-display-runtime";
import { formatTime } from "@/lib/i18n";
import { useAppStore } from "@/lib/store";
import { useHydrated } from "@/lib/use-hydrated";

export interface DisplayLocation {
  slug: string;
  name: string;
  lat: number;
  lon: number;
}

interface Props {
  location: DisplayLocation;
  initialWeather: WeatherData | null;
  layer: string;
  theme: DisplayTheme | null;
}

/**
 * The full-screen weather display: one glanceable screen for a TV, tablet or
 * monitor on a wall. Landscape puts the radar map beside the readings;
 * portrait stacks them. Every panel has its own error boundary and keeps its
 * last good data on a failed refresh, so the screen never goes blank.
 */
export function DisplayDashboard({
  location,
  initialWeather,
  layer,
  theme,
}: Props) {
  useWakeLock();
  usePeriodicReload();
  const hydrated = useHydrated();

  const setTheme = useAppStore((s) => s.setTheme);
  useEffect(() => {
    if (theme) setTheme(theme);
  }, [theme, setTheme]);

  const coords = `lat=${location.lat}&lon=${location.lon}`;
  const weatherState = usePolledJson(
    `/api/py/weather?${coords}`,
    DISPLAY_REFRESH_MS.weather,
    isDisplayWeather,
    initialWeather ?? undefined,
  );
  const airState = usePolledJson<AirQualityResponse>(
    `/api/py/airquality?${coords}`,
    DISPLAY_REFRESH_MS.airQuality,
    isAirQuality,
  );

  const weather =
    weatherState.status === "loading" ? null : (weatherState.data ?? null);
  const air = airState.status === "loading" ? null : (airState.data ?? null);
  const stale = weatherState.status === "error" && weather !== null;
  const updatedAt =
    weatherState.status !== "loading" ? weatherState.updatedAt : undefined;

  return (
    <main
      id="main-content"
      className="flex min-h-dvh flex-col gap-4 bg-background p-4 lg:h-dvh lg:overflow-hidden lg:p-6"
    >
      <DisplayClock locationName={location.name} />

      <div className="grid flex-1 gap-4 lg:min-h-0 lg:grid-cols-12">
        <div className="flex flex-col gap-4 lg:col-span-5 lg:min-h-0">
          <ChartErrorBoundary name="current conditions">
            {weather ? (
              <DisplayNow weather={weather} />
            ) : (
              <div
                className="chameleon h-64"
                role="status"
                aria-label="Loading current conditions"
              />
            )}
          </ChartErrorBoundary>
          <ChartErrorBoundary name="air quality">
            {airState.status === "loading" ? (
              <div
                className="chameleon h-40"
                role="status"
                aria-label="Loading air quality"
              />
            ) : (
              <DisplayAirQuality air={air} />
            )}
          </ChartErrorBoundary>
          {weather && (
            <div className="hidden flex-1 lg:[@media(min-height:900px)]:flex lg:min-h-0 [&>*]:flex-1">
              <ChartErrorBoundary name="today's outlook">
                <DisplayOutlook weather={weather} />
              </ChartErrorBoundary>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-4 lg:col-span-7 lg:min-h-0">
          <div className="min-h-[18rem] flex-1 lg:min-h-0">
            <ChartErrorBoundary name="weather map">
              <DisplayRadar
                lat={location.lat}
                lon={location.lon}
                layer={layer}
              />
            </ChartErrorBoundary>
          </div>
          {weather && (
            <>
              <ChartErrorBoundary name="hourly forecast">
                <DisplayHours weather={weather} />
              </ChartErrorBoundary>
              <ChartErrorBoundary name="5-day forecast">
                <DisplayDays weather={weather} />
              </ChartErrorBoundary>
            </>
          )}
        </div>
      </div>

      <footer
        className="flex flex-wrap items-center justify-between gap-2 text-sm text-text-tertiary"
        role="contentinfo"
      >
        <span>
          {stale
            ? "Showing the last reading — reconnecting…"
            : hydrated && updatedAt
              ? `Updated ${formatTime(new Date(updatedAt))}`
              : " "}
        </span>
        <span>weather.mukoko.com/display · Air quality: Open-Meteo (CAMS)</span>
      </footer>
    </main>
  );
}
