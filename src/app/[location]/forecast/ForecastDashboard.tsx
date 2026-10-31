"use client";

import { lazy, Suspense } from "react";
import { PageShell } from "@/components/layout/PageShell";
import { SeasonBadge } from "@/components/weather/SeasonBadge";
import { LazySection } from "@/components/weather/LazySection";
import { ChartErrorBoundary } from "@/components/weather/ChartErrorBoundary";
import { SectionSkeleton } from "@/components/weather/SectionSkeleton";
import { FrostAlertBanner } from "../FrostAlertBanner";
import { WeatherUnavailableBanner } from "../WeatherUnavailableBanner";
import type { WeatherData, FrostAlert, Season } from "@/lib/weather";
import type { WeatherLocation } from "@/lib/locations";

const HourlyForecast = lazy(() =>
  import("@/components/weather/HourlyForecast").then((m) => ({
    default: m.HourlyForecast,
  })),
);
const DailyForecast = lazy(() =>
  import("@/components/weather/DailyForecast").then((m) => ({
    default: m.DailyForecast,
  })),
);
const SunTimes = lazy(() =>
  import("@/components/weather/SunTimes").then((m) => ({
    default: m.SunTimes,
  })),
);

interface Props {
  weather: WeatherData;
  location: WeatherLocation;
  usingFallback: boolean;
  frostAlert: FrostAlert | null;
  season: Season;
}

export function ForecastDashboard({
  weather,
  location,
  usingFallback,
  frostAlert,
  season,
}: Props) {
  return (
    <PageShell
      width="wide"
      label={`Weather forecast for ${location.name}`}
      className="overflow-x-clip"
      breadcrumb={[
        { label: "Home", href: "/" },
        { label: location.name, href: `/${location.slug}` },
        { label: "Forecast" },
      ]}
    >
      <h1 className="elephant">{location.name} Forecast</h1>
      <p className="mt-1 text-base text-text-secondary">
        {location.province} &middot; {location.elevation}m &middot;{" "}
        {season.localName} ({season.name})
      </p>

      <div className="mt-4 mb-4">
        <SeasonBadge season={season} />
      </div>

      {usingFallback && <WeatherUnavailableBanner />}
      {frostAlert && <FrostAlertBanner alert={frostAlert} />}

      {/* Forecast charts — 2-column grid on desktop, stacked on mobile */}
      <div className="mt-6 grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        {/* Hourly forecast (24h) */}
        <ChartErrorBoundary name="hourly forecast">
          <Suspense fallback={<SectionSkeleton />}>
            <HourlyForecast
              hourly={weather.hourly}
              utcOffsetSeconds={weather.utc_offset_seconds}
            />
          </Suspense>
        </ChartErrorBoundary>

        {/* 7-day daily forecast */}
        <ChartErrorBoundary name="daily forecast">
          <Suspense fallback={<SectionSkeleton />}>
            <DailyForecast daily={weather.daily} />
          </Suspense>
        </ChartErrorBoundary>

        {/* Sunrise & sunset — spans both columns */}
        <LazySection label="sun-times" className="lg:col-span-2">
          <ChartErrorBoundary name="sun times">
            <Suspense fallback={<SectionSkeleton />}>
              <SunTimes
                daily={weather.daily}
                utcOffsetSeconds={weather.utc_offset_seconds}
              />
            </Suspense>
          </ChartErrorBoundary>
        </LazySection>
      </div>
    </PageShell>
  );
}
