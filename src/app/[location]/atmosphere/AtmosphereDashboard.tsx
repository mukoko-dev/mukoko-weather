"use client";

import { lazy, Suspense } from "react";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { Breadcrumb } from "@/components/layout/Breadcrumb";
import { AtmosphericSummary } from "@/components/weather/AtmosphericSummary";
import { SeasonBadge } from "@/components/weather/SeasonBadge";
import { LazySection } from "@/components/weather/LazySection";
import { ChartErrorBoundary } from "@/components/weather/ChartErrorBoundary";
import { SectionSkeleton } from "@/components/weather/SectionSkeleton";
import { FrostAlertBanner } from "../FrostAlertBanner";
import { WeatherUnavailableBanner } from "../WeatherUnavailableBanner";
import type { WeatherData, FrostAlert, Season } from "@/lib/weather";
import type { WeatherLocation } from "@/lib/locations";

const AtmosphericDetails = lazy(() =>
  import("@/components/weather/AtmosphericDetails").then((m) => ({
    default: m.AtmosphericDetails,
  })),
);

const AirQualityDetails = lazy(() =>
  import("@/components/weather/AirQualityDetails").then((m) => ({
    default: m.AirQualityDetails,
  })),
);

interface Props {
  weather: WeatherData;
  location: WeatherLocation;
  usingFallback: boolean;
  frostAlert: FrostAlert | null;
  season: Season;
}

export function AtmosphereDashboard({
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
          { label: "Atmosphere" },
        ]}
      />

      <main
        id="main-content"
        className="mx-auto max-w-5xl overflow-x-hidden px-4 py-8 pb-24 sm:pb-8 sm:px-6 md:px-8"
        aria-label={`Atmospheric conditions for ${location.name}`}
      >
        <h1 className="text-2xl font-bold text-text-primary font-heading sm:text-3xl">
          {location.name} Atmosphere
        </h1>
        <p className="mt-1 text-base text-text-secondary">
          {location.province} &middot; {location.elevation}m &middot; {season.localName} ({season.name})
        </p>

        <div className="mt-4 mb-4">
          <SeasonBadge season={season} />
        </div>

        {usingFallback && <WeatherUnavailableBanner />}
        {frostAlert && <FrostAlertBanner alert={frostAlert} />}

        {/* Current conditions summary cards */}
        <div className="mt-6">
          <ChartErrorBoundary name="atmospheric conditions">
            <AtmosphericSummary current={weather.current} lat={location.lat} lon={location.lon} />
          </ChartErrorBoundary>
        </div>

        {/* 24-hour atmospheric charts */}
        <div className="mt-8">
          <LazySection label="atmospheric-details">
            <ChartErrorBoundary name="atmospheric details charts">
              <Suspense fallback={<SectionSkeleton />}>
                <AtmosphericDetails hourly={weather.hourly} />
              </Suspense>
            </ChartErrorBoundary>
          </LazySection>
        </div>

        {/* Air quality — full pollutant breakdown with WHO comparison */}
        <div className="mt-8">
          <LazySection label="air-quality-details">
            <ChartErrorBoundary name="air quality details">
              <Suspense fallback={<SectionSkeleton />}>
                <AirQualityDetails lat={location.lat} lon={location.lon} />
              </Suspense>
            </ChartErrorBoundary>
          </LazySection>
        </div>
      </main>

      <Footer />
    </>
  );
}
