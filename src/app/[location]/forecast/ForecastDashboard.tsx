"use client";

import { lazy, Suspense } from "react";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { Breadcrumb } from "@/components/layout/Breadcrumb";
import { SeasonBadge } from "@/components/weather/SeasonBadge";
import { LazySection } from "@/components/weather/LazySection";
import { ChartErrorBoundary } from "@/components/weather/ChartErrorBoundary";
import { SectionSkeleton } from "@/components/weather/SectionSkeleton";
import { FrostAlertBanner } from "../FrostAlertBanner";
import { WeatherUnavailableBanner } from "../WeatherUnavailableBanner";
import type { WeatherData, FrostAlert, Season } from "@/lib/weather";
import type { WeatherLocation } from "@/lib/locations";

const HourlyForecast = lazy(() => import("@/components/weather/HourlyForecast").then((m) => ({ default: m.HourlyForecast })));
const DailyForecast = lazy(() => import("@/components/weather/DailyForecast").then((m) => ({ default: m.DailyForecast })));
const SunTimes = lazy(() => import("@/components/weather/SunTimes").then((m) => ({ default: m.SunTimes })));

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
    <>
      <Header />

      <Breadcrumb
        items={[
          { label: "Home", href: "/" },
          { label: location.name, href: `/${location.slug}` },
          { label: "Forecast" },
        ]}
      />

      <main
        id="main-content"
        className="mx-auto max-w-5xl overflow-x-hidden px-4 py-8 pb-24 sm:pb-8 sm:px-6 md:px-8"
        aria-label={`Weather forecast for ${location.name}`}
      >
        <h1 className="text-2xl font-bold text-text-primary font-heading sm:text-3xl">
          {location.name} Forecast
        </h1>
        <p className="mt-1 text-base text-text-secondary">
          {location.province} &middot; {location.elevation}m &middot; {season.localName} ({season.name})
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
              <HourlyForecast hourly={weather.hourly} />
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
                <SunTimes daily={weather.daily} />
              </Suspense>
            </ChartErrorBoundary>
          </LazySection>
        </div>
      </main>

      <Footer />
    </>
  );
}
