"use client";

import { lazy, Suspense } from "react";
import { PageShell } from "@/components/layout/PageShell";
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
    <PageShell
      width="wide"
      label={`Atmospheric conditions for ${location.name}`}
      className="overflow-x-clip"
      breadcrumb={[
        { label: "Home", href: "/" },
        { label: location.name, href: `/${location.slug}` },
        { label: "Atmosphere" },
      ]}
    >
      <h1 className="elephant">{location.name} Atmosphere</h1>
      <p className="mt-1 text-base text-text-secondary">
        {location.province} &middot; {location.elevation}m &middot;{" "}
        {season.localName} ({season.name})
      </p>

      <div className="mt-4 mb-4">
        <SeasonBadge season={season} />
      </div>

      {usingFallback && <WeatherUnavailableBanner />}
      {frostAlert && <FrostAlertBanner alert={frostAlert} />}

      {/* Current conditions summary cards */}
      <div className="mt-6">
        <ChartErrorBoundary name="atmospheric conditions">
          <AtmosphericSummary
            current={weather.current}
            weather={weather}
            lat={location.lat}
            lon={location.lon}
          />
        </ChartErrorBoundary>
      </div>

      {/* 24-hour atmospheric charts */}
      <div className="mt-8">
        <LazySection label="atmospheric-details">
          <ChartErrorBoundary name="atmospheric details charts">
            <Suspense fallback={<SectionSkeleton />}>
              <AtmosphericDetails
                hourly={weather.hourly}
                utcOffsetSeconds={weather.utc_offset_seconds}
              />
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
    </PageShell>
  );
}
