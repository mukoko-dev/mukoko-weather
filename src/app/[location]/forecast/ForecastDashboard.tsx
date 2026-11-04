"use client";

import { lazy, Suspense } from "react";
import { PageShell } from "@/components/layout/PageShell";
import { LazySection } from "@/components/weather/LazySection";
import { ChartErrorBoundary } from "@/components/weather/ChartErrorBoundary";
import { SectionSkeleton } from "@/components/weather/SectionSkeleton";
import { PageWeatherNotice } from "@/components/weather/PageWeatherNotice";
import { SubRouteHeader } from "@/components/weather/SubRouteHeader";
import { ForecastBodySkeleton } from "@/components/weather/SubRouteSkeletons";
import { UpdatedAgo } from "@/components/weather/UpdatedAgo";
import { usePageWeather } from "@/lib/use-page-weather";
import { FrostAlertBanner } from "../FrostAlertBanner";
import { WeatherUnavailableBanner } from "../WeatherUnavailableBanner";
import type { Season } from "@/lib/weather";
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
  /** The place and its season. The server sends NO weather (issue #452). */
  location: WeatherLocation;
  season: Season;
}

/**
 * The forecast page. The server sends the heading, the place line and the
 * skeleton; the forecast is the visitor's own request, painted over the copy
 * stored on the device (`usePageWeather`). Render with `key={location.slug}`.
 */
export function ForecastDashboard({ location: seedLocation, season }: Props) {
  const { state, view, retry } = usePageWeather({
    location: seedLocation,
    season,
    countryName: "",
  });
  // The forecast corrects a placeholder height and a borrowed country.
  const location = view?.location ?? seedLocation;
  const weather = view?.weather;

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
      <SubRouteHeader
        title={`${location.name} Forecast`}
        location={location}
        season={season}
      />

      {view && state.device && (
        <UpdatedAgo
          fetchedAt={state.device.fetchedAt}
          freshness={state.device.freshness}
          weather={view.weather}
          placeName={location.name}
        />
      )}
      {view?.usingFallback && <WeatherUnavailableBanner onRetry={retry} />}
      {view?.frostAlert && <FrostAlertBanner alert={view.frostAlert} />}

      {weather ? (
        /* Forecast charts — 2-column grid on desktop, stacked on mobile */
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
      ) : (
        <ForecastBodySkeleton />
      )}

      <PageWeatherNotice state={state} retry={retry} />
    </PageShell>
  );
}
