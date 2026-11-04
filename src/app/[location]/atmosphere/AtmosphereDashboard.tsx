"use client";

import { lazy, Suspense } from "react";
import { PageShell } from "@/components/layout/PageShell";
import { AtmosphericSummary } from "@/components/weather/AtmosphericSummary";
import { LazySection } from "@/components/weather/LazySection";
import { ChartErrorBoundary } from "@/components/weather/ChartErrorBoundary";
import { SectionSkeleton } from "@/components/weather/SectionSkeleton";
import { PageWeatherNotice } from "@/components/weather/PageWeatherNotice";
import { SubRouteHeader } from "@/components/weather/SubRouteHeader";
import { AtmosphereBodySkeleton } from "@/components/weather/SubRouteSkeletons";
import { UpdatedAgo } from "@/components/weather/UpdatedAgo";
import { usePageWeather } from "@/lib/use-page-weather";
import { FrostAlertBanner } from "../FrostAlertBanner";
import { WeatherUnavailableBanner } from "../WeatherUnavailableBanner";
import type { Season } from "@/lib/weather";
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
  /** The place and its season. The server sends NO weather (issue #452). */
  location: WeatherLocation;
  season: Season;
}

/**
 * The atmosphere page. The server sends the heading, the place line and the
 * skeleton; the forecast is the visitor's own request, painted over the copy
 * stored on the device (`usePageWeather`). Air quality has its own read and
 * does not wait for the forecast. Render with `key={location.slug}`.
 */
export function AtmosphereDashboard({ location: seedLocation, season }: Props) {
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
      label={`Atmospheric conditions for ${location.name}`}
      className="overflow-x-clip"
      breadcrumb={[
        { label: "Home", href: "/" },
        { label: location.name, href: `/${location.slug}` },
        { label: "Atmosphere" },
      ]}
    >
      <SubRouteHeader
        title={`${location.name} Atmosphere`}
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
        <>
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
        </>
      ) : (
        <AtmosphereBodySkeleton />
      )}

      {/* Air quality — full pollutant breakdown with WHO comparison. It reads
          its own data, so it does not wait for the forecast. */}
      <div className="mt-8">
        <LazySection label="air-quality-details">
          <ChartErrorBoundary name="air quality details">
            <Suspense fallback={<SectionSkeleton />}>
              <AirQualityDetails lat={location.lat} lon={location.lon} />
            </Suspense>
          </ChartErrorBoundary>
        </LazySection>
      </div>

      <PageWeatherNotice state={state} retry={retry} />
    </PageShell>
  );
}
