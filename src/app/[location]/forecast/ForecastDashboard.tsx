"use client";

import { lazy, Suspense } from "react";
import Link from "next/link";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { SeasonBadge } from "@/components/weather/SeasonBadge";
import { LazySection } from "@/components/weather/LazySection";
import { ChartErrorBoundary } from "@/components/weather/ChartErrorBoundary";
import { SectionSkeleton } from "@/components/weather/SectionSkeleton";
import { FrostAlertBanner } from "../FrostAlertBanner";
import { WeatherUnavailableBanner } from "../WeatherUnavailableBanner";
import type { WeatherData, FrostAlert, ZimbabweSeason } from "@/lib/weather";
import type { ZimbabweLocation } from "@/lib/locations";

const HourlyForecast = lazy(() => import("@/components/weather/HourlyForecast").then((m) => ({ default: m.HourlyForecast })));
const DailyForecast = lazy(() => import("@/components/weather/DailyForecast").then((m) => ({ default: m.DailyForecast })));
const SunTimes = lazy(() => import("@/components/weather/SunTimes").then((m) => ({ default: m.SunTimes })));

interface Props {
  weather: WeatherData;
  location: ZimbabweLocation;
  usingFallback: boolean;
  frostAlert: FrostAlert | null;
  season: ZimbabweSeason;
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

      <nav aria-label="Breadcrumb" className="mx-auto max-w-5xl px-4 pt-4 sm:px-6 md:px-8">
        <ol className="flex items-center gap-1 text-xs text-text-tertiary">
          <li>
            <Link href="/" className="hover:text-text-secondary transition-colors focus-visible:outline-2 focus-visible:outline-primary focus-visible:rounded">
              Home
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <Link href={`/${location.slug}`} className="hover:text-text-secondary transition-colors focus-visible:outline-2 focus-visible:outline-primary focus-visible:rounded">
              {location.name}
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page">
            <span className="font-medium text-text-primary">Forecast</span>
          </li>
        </ol>
      </nav>

      <main
        id="main-content"
        className="mx-auto max-w-5xl overflow-x-hidden px-4 py-8 pb-24 sm:pb-8 sm:px-6 md:px-8"
        aria-label={`Weather forecast for ${location.name}`}
      >
        <h1 className="text-2xl font-bold text-text-primary font-heading sm:text-3xl">
          {location.name} Forecast
        </h1>
        <p className="mt-1 text-sm text-text-secondary">
          {location.province} &middot; {location.elevation}m &middot; {season.shona} ({season.name})
        </p>

        <div className="mt-4 mb-4">
          <SeasonBadge season={season} />
        </div>

        {usingFallback && <WeatherUnavailableBanner />}
        {frostAlert && <FrostAlertBanner alert={frostAlert} />}

        {/* Hourly forecast (24h) */}
        <div className="mt-6">
          <ChartErrorBoundary name="hourly forecast">
            <Suspense fallback={<SectionSkeleton />}>
              <HourlyForecast hourly={weather.hourly} />
            </Suspense>
          </ChartErrorBoundary>
        </div>

        {/* 7-day daily forecast */}
        <div className="mt-8">
          <ChartErrorBoundary name="daily forecast">
            <Suspense fallback={<SectionSkeleton />}>
              <DailyForecast daily={weather.daily} />
            </Suspense>
          </ChartErrorBoundary>
        </div>

        {/* Sunrise & sunset */}
        <LazySection label="sun-times">
          <div className="mt-8">
            <ChartErrorBoundary name="sun times">
              <Suspense fallback={<SectionSkeleton />}>
                <SunTimes daily={weather.daily} />
              </Suspense>
            </ChartErrorBoundary>
          </div>
        </LazySection>
      </main>

      <Footer />
    </>
  );
}
