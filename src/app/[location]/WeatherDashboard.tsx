"use client";

import { lazy, Suspense, useEffect, useState } from "react";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { CurrentConditions } from "@/components/weather/CurrentConditions";
import { SeasonBadge } from "@/components/weather/SeasonBadge";
import { LazySection } from "@/components/weather/LazySection";
import { ChartErrorBoundary } from "@/components/weather/ChartErrorBoundary";
import { SectionSkeleton } from "@/components/weather/SectionSkeleton";
import { FrostAlertBanner } from "./FrostAlertBanner";
import { WeatherUnavailableBanner } from "./WeatherUnavailableBanner";
import { useAppStore } from "@/lib/store";
import type { WeatherData, FrostAlert, ZimbabweSeason } from "@/lib/weather";
import type { ZimbabweLocation } from "@/lib/locations";
import { type Activity, ACTIVITIES } from "@/lib/activities";
import { InfoRow } from "@/components/ui/info-row";

// ── Code-split heavy components ─────────────────────────────────────────────
// These use React.lazy() so their JS chunks (Chart.js, ReactMarkdown, etc.)
// are only downloaded when the LazySection IntersectionObserver fires.
// This dramatically reduces the initial JS parse/compile on iOS PWA.
const HourlyForecast = lazy(() => import("@/components/weather/HourlyForecast").then((m) => ({ default: m.HourlyForecast })));
const DailyForecast = lazy(() => import("@/components/weather/DailyForecast").then((m) => ({ default: m.DailyForecast })));
const AISummary = lazy(() => import("@/components/weather/AISummary").then((m) => ({ default: m.AISummary })));
const ActivityInsights = lazy(() => import("@/components/weather/ActivityInsights").then((m) => ({ default: m.ActivityInsights })));
const AtmosphericSummary = lazy(() => import("@/components/weather/AtmosphericSummary").then((m) => ({ default: m.AtmosphericSummary })));
const SunTimes = lazy(() => import("@/components/weather/SunTimes").then((m) => ({ default: m.SunTimes })));
const MapPreview = lazy(() => import("@/components/weather/map/MapPreview").then((m) => ({ default: m.MapPreview })));

const BASE_URL = "https://weather.mukoko.com";

interface WeatherDashboardProps {
  weather: WeatherData;
  location: ZimbabweLocation;
  usingFallback: boolean;
  frostAlert: FrostAlert | null;
  season: ZimbabweSeason;
  /** Resolved country name — shown in breadcrumbs for non-ZW locations */
  countryName?: string;
}

export function WeatherDashboard({
  weather,
  location,
  usingFallback,
  frostAlert,
  season,
  countryName,
}: WeatherDashboardProps) {
  const setSelectedLocation = useAppStore((s) => s.setSelectedLocation);
  const selectedActivities = useAppStore((s) => s.selectedActivities);

  // Seed with static ACTIVITIES for instant rendering, then upgrade from MongoDB.
  // This prevents a blank ActivityInsights section on slow connections or cold starts.
  const [allActivities, setAllActivities] = useState<Activity[]>(ACTIVITIES);
  useEffect(() => {
    if (selectedActivities.length === 0) return;
    fetch("/api/activities")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data?.activities?.length) setAllActivities(data.activities); })
      .catch(() => {});
  }, [selectedActivities.length]);

  // Sync the URL-driven location to the global store so other pages
  // (history, etc.) can use it as their default.
  useEffect(() => {
    setSelectedLocation(location.slug);
  }, [location.slug, setSelectedLocation]);

  return (
    <>
      <Header />

      {/* Breadcrumb navigation for SEO and accessibility */}
      <nav aria-label="Breadcrumb" className="mx-auto max-w-5xl px-4 pt-4 sm:px-6 md:px-8">
        <ol className="flex flex-wrap items-center gap-1 text-xs text-text-tertiary">
          <li>
            <a href={BASE_URL} className="hover:text-text-secondary transition-colors focus-visible:outline-2 focus-visible:outline-primary focus-visible:rounded">
              Home
            </a>
          </li>
          <li aria-hidden="true">/</li>
          {/* Show country for non-ZW locations so global users have context */}
          {countryName && location.country && location.country !== "ZW" && (
            <>
              <li>
                <span className="text-text-secondary">{countryName}</span>
              </li>
              <li aria-hidden="true">/</li>
            </>
          )}
          <li>
            <span className="text-text-secondary">{location.province}</span>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page">
            <span className="font-medium text-text-primary">{location.name}</span>
          </li>
        </ol>
      </nav>

      {/* pb-24 reserves space on mobile for a future sticky bottom nav bar;
          sm:pb-6 restores normal padding on larger screens where there is no nav bar. */}
      <main
        id="main-content"
        className="mx-auto max-w-5xl overflow-x-hidden px-4 py-6 pb-24 sm:px-6 sm:pb-6 md:px-8"
        aria-label={`Weather dashboard for ${location.name}`}
      >
        {/* H1 for SEO — visually integrated but semantically correct */}
        <h1 className="sr-only">{location.name} Weather Forecast — Current Conditions and 7-Day Outlook</h1>

        {/* Season indicator */}
        <div className="mb-4">
          <SeasonBadge season={season} />
        </div>

        {/* Weather unavailable banner — shown when all providers failed */}
        {usingFallback && <WeatherUnavailableBanner />}

        {/* Frost alert banner */}
        {frostAlert && <FrostAlertBanner alert={frostAlert} />}

        {/* Main grid */}
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Left column: Current + AI Summary */}
          <div className="min-w-0 space-y-6 lg:col-span-2">
            <ChartErrorBoundary name="current conditions">
              <CurrentConditions
                current={weather.current}
                locationName={location.name}
                daily={weather.daily}
                slug={location.slug}
              />
            </ChartErrorBoundary>
            <LazySection label="hourly-forecast">
              <ChartErrorBoundary name="hourly forecast">
                <Suspense fallback={<SectionSkeleton />}>
                  <HourlyForecast hourly={weather.hourly} />
                </Suspense>
              </ChartErrorBoundary>
            </LazySection>
            <LazySection label="ai-summary">
              <ChartErrorBoundary name="AI summary">
                <Suspense fallback={<SectionSkeleton />}>
                  {!usingFallback && <AISummary weather={weather} location={location} />}
                </Suspense>
              </ChartErrorBoundary>
            </LazySection>
            <LazySection label="activity-insights">
              <ChartErrorBoundary name="activity insights">
                <Suspense fallback={<SectionSkeleton />}>
                  <ActivityInsights insights={weather.insights} activities={allActivities} />
                </Suspense>
              </ChartErrorBoundary>
            </LazySection>
            <LazySection label="atmospheric-summary">
              <ChartErrorBoundary name="atmospheric conditions">
                <Suspense fallback={<SectionSkeleton />}>
                  <AtmosphericSummary current={weather.current} />
                </Suspense>
              </ChartErrorBoundary>
            </LazySection>
          </div>

          {/* Right column: Daily + Sun + Info */}
          <div className="min-w-0 space-y-6">
            <LazySection label="daily-forecast">
              <ChartErrorBoundary name="daily forecast">
                <Suspense fallback={<SectionSkeleton />}>
                  <DailyForecast daily={weather.daily} />
                </Suspense>
              </ChartErrorBoundary>
            </LazySection>
            <LazySection label="sun-times">
              <ChartErrorBoundary name="sun times">
                <Suspense fallback={<SectionSkeleton />}>
                  <SunTimes daily={weather.daily} />
                </Suspense>
              </ChartErrorBoundary>
            </LazySection>

            <LazySection label="weather-map">
              <ChartErrorBoundary name="weather map">
                <Suspense fallback={<SectionSkeleton />}>
                  <MapPreview location={location} />
                </Suspense>
              </ChartErrorBoundary>
            </LazySection>

            {/* Location info card */}
            <LazySection label="location-info">
              <section aria-labelledby={`about-${location.slug}`}>
                <div className="rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm sm:p-6">
                  <h2 id={`about-${location.slug}`} className="text-lg font-semibold text-text-primary font-heading">
                    About {location.name}
                  </h2>
                  <dl className="mt-4 space-y-3 text-sm">
                    <InfoRow label="Province" value={location.province} />
                    <InfoRow label="Elevation" value={`${location.elevation}m`} />
                    <InfoRow
                      label="Coordinates"
                      value={
                        <span className="font-mono text-xs">
                          {location.lat.toFixed(2)}, {location.lon.toFixed(2)}
                        </span>
                      }
                    />
                    <InfoRow label="Season" value={`${season.shona} (${season.name})`} />
                  </dl>
                </div>
              </section>
            </LazySection>
          </div>
        </div>
      </main>

      <Footer />
    </>
  );
}
