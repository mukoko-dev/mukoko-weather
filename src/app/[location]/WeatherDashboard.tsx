"use client";

import { lazy, Suspense, useEffect, useState } from "react";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { CurrentConditions } from "@/components/weather/CurrentConditions";
import { SeasonBadge } from "@/components/weather/SeasonBadge";
import { LazySection } from "@/components/weather/LazySection";
import { ChartErrorBoundary } from "@/components/weather/ChartErrorBoundary";
import {
  ReportsSkeleton,
  HourlyForecastSkeleton,
  ActivityInsightsSkeleton,
  DailyForecastSkeleton,
  AISummarySkeleton,
  AISummaryChatSkeleton,
  AtmosphericSummarySkeleton,
  SunTimesSkeleton,
  MapPreviewSkeleton,
  SupportBannerSkeleton,
  LocationInfoSkeleton,
} from "@/components/weather/SectionSkeleton";
import { FrostAlertBanner } from "./FrostAlertBanner";
import { WeatherUnavailableBanner } from "./WeatherUnavailableBanner";
import { useAppStore } from "@/lib/store";
import type { WeatherData, FrostAlert, ZimbabweSeason } from "@/lib/weather";
import type { ZimbabweLocation } from "@/lib/locations";
import { type Activity, ACTIVITIES } from "@/lib/activities";
import { InfoRow } from "@/components/ui/info-row";
import { SupportBanner } from "@/components/weather/SupportBanner";
import { cacheWeatherHint } from "@/lib/weather-scenes";

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
const AISummaryChat = lazy(() => import("@/components/weather/AISummaryChat").then((m) => ({ default: m.AISummaryChat })));
const RecentReports = lazy(() => import("@/components/weather/reports/RecentReports").then((m) => ({ default: m.RecentReports })));

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
  const hasOnboarded = useAppStore((s) => s.hasOnboarded);
  const completeOnboarding = useAppStore((s) => s.completeOnboarding);
  const [aiSummary, setAiSummary] = useState<string | null>(null);

  // Seed with static ACTIVITIES for instant rendering, then upgrade from MongoDB.
  // This prevents a blank ActivityInsights section on slow connections or cold starts.
  const [allActivities, setAllActivities] = useState<Activity[]>(ACTIVITIES);
  useEffect(() => {
    if (selectedActivities.length === 0) return;
    fetch("/api/py/activities")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data?.activities?.length) setAllActivities(data.activities); })
      .catch(() => {});
  }, [selectedActivities.length]);

  // Sync the URL-driven location to the global store so other pages
  // (history, etc.) can use it as their default.
  useEffect(() => {
    setSelectedLocation(location.slug);
  }, [location.slug, setSelectedLocation]);

  // Auto-complete onboarding — seeing your forecast IS the onboarding.
  // No forced personalization step. Matches Apple/Google Weather pattern:
  // detect location → show weather → done. Users who want to personalize
  // can tap the map pin icon in the header at any time.
  useEffect(() => {
    if (!hasOnboarded) completeOnboarding();
  }, [hasOnboarded, completeOnboarding]);

  // Cache weather hint for the loading scene — enables weather-aware
  // Three.js animation on subsequent visits to this location.
  useEffect(() => {
    cacheWeatherHint(location.slug, {
      weatherCode: weather.current.weather_code,
      isDay: weather.current.is_day === 1,
      temperature: weather.current.temperature_2m,
      windSpeed: weather.current.wind_speed_10m,
      timestamp: Date.now(),
    });
  }, [location.slug, weather.current.weather_code, weather.current.is_day, weather.current.temperature_2m, weather.current.wind_speed_10m]);

  return (
    <>
      <Header />

      {/* Breadcrumb navigation for SEO and accessibility */}
      <nav aria-label="Breadcrumb" className="mx-auto max-w-5xl px-4 pt-5 sm:px-6 md:px-8">
        <ol className="flex flex-wrap items-center gap-1.5 text-base text-text-tertiary">
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
        className="animate-fade-in mx-auto max-w-5xl overflow-x-hidden px-4 py-8 pb-24 sm:px-6 sm:pb-8 md:px-8"
        aria-label={`Weather dashboard for ${location.name}`}
      >
        {/* H1 for SEO — visually integrated but semantically correct */}
        <h1 className="sr-only">{location.name} Weather Forecast — Current Conditions and 7-Day Outlook</h1>

        {/* Screen reader announcement for loading→loaded transition (WCAG) */}
        <div aria-live="polite" className="sr-only">
          Weather loaded for {location.name}
        </div>

        {/* Season indicator */}
        <div className="mb-5">
          <SeasonBadge season={season} />
        </div>

        {/* Weather unavailable banner — shown when all providers failed */}
        {usingFallback && <WeatherUnavailableBanner />}

        {/* Frost alert banner */}
        {frostAlert && <FrostAlertBanner alert={frostAlert} />}

        {/* Main grid — simple 2-section layout.
            Mobile: single column, natural DOM order
            Desktop (lg): 3 columns — primary content in cols 1-2, sidebar in col 3 */}
        <div className="grid gap-8 lg:grid-cols-3 lg:gap-10">
          {/* Primary content — lg:col-span-2 */}
          <div className="min-w-0 space-y-8 lg:col-span-2">
            <ChartErrorBoundary name="current conditions">
              <CurrentConditions
                current={weather.current}
                locationName={location.name}
                daily={weather.daily}
                slug={location.slug}
              />
            </ChartErrorBoundary>
            <LazySection label="community-reports" fallback={<ReportsSkeleton />}>
              <ChartErrorBoundary name="community reports">
                <Suspense fallback={<ReportsSkeleton />}>
                  <RecentReports locationSlug={location.slug} />
                </Suspense>
              </ChartErrorBoundary>
            </LazySection>
            <LazySection label="hourly-forecast" fallback={<HourlyForecastSkeleton />}>
              <ChartErrorBoundary name="hourly forecast">
                <Suspense fallback={<HourlyForecastSkeleton />}>
                  <HourlyForecast hourly={weather.hourly} />
                </Suspense>
              </ChartErrorBoundary>
            </LazySection>
            <LazySection label="activity-insights" fallback={<ActivityInsightsSkeleton />}>
              <ChartErrorBoundary name="activity insights">
                <Suspense fallback={<ActivityInsightsSkeleton />}>
                  <ActivityInsights insights={weather.insights} activities={allActivities} />
                </Suspense>
              </ChartErrorBoundary>
            </LazySection>
            <LazySection label="daily-forecast" fallback={<DailyForecastSkeleton />}>
              <ChartErrorBoundary name="daily forecast">
                <Suspense fallback={<DailyForecastSkeleton />}>
                  <DailyForecast daily={weather.daily} />
                </Suspense>
              </ChartErrorBoundary>
            </LazySection>
            <LazySection label="ai-summary" fallback={<AISummarySkeleton />}>
              <ChartErrorBoundary name="AI summary">
                <Suspense fallback={<AISummarySkeleton />}>
                  {!usingFallback && <AISummary weather={weather} location={location} onSummaryLoaded={setAiSummary} />}
                </Suspense>
              </ChartErrorBoundary>
            </LazySection>
            {aiSummary && !usingFallback && (
              <LazySection label="ai-followup-chat" fallback={<AISummaryChatSkeleton />}>
                <ChartErrorBoundary name="AI follow-up chat">
                  <Suspense fallback={<AISummaryChatSkeleton />}>
                    <AISummaryChat
                      weather={weather}
                      location={location}
                      initialSummary={aiSummary}
                      season={`${season.shona} (${season.name})`}
                    />
                  </Suspense>
                </ChartErrorBoundary>
              </LazySection>
            )}
            <LazySection label="atmospheric-summary" fallback={<AtmosphericSummarySkeleton />}>
              <ChartErrorBoundary name="atmospheric conditions">
                <Suspense fallback={<AtmosphericSummarySkeleton />}>
                  <AtmosphericSummary current={weather.current} />
                </Suspense>
              </ChartErrorBoundary>
            </LazySection>
          </div>

          {/* Sidebar — stacks below on mobile */}
          <div className="min-w-0 space-y-8">
            <LazySection label="sun-times" fallback={<SunTimesSkeleton />}>
              <ChartErrorBoundary name="sun times">
                <Suspense fallback={<SunTimesSkeleton />}>
                  <SunTimes daily={weather.daily} />
                </Suspense>
              </ChartErrorBoundary>
            </LazySection>

            <LazySection label="weather-map" fallback={<MapPreviewSkeleton />}>
              <ChartErrorBoundary name="weather map">
                <Suspense fallback={<MapPreviewSkeleton />}>
                  <MapPreview location={location} />
                </Suspense>
              </ChartErrorBoundary>
            </LazySection>

            <LazySection label="support-banner" fallback={<SupportBannerSkeleton />}>
              <ChartErrorBoundary name="support banner">
                <SupportBanner />
              </ChartErrorBoundary>
            </LazySection>

            {/* Location info card */}
            <LazySection label="location-info" fallback={<LocationInfoSkeleton />}>
              <section aria-labelledby={`about-${location.slug}`}>
                <div className="rounded-[var(--radius-card)] border border-primary/25 bg-surface-card p-5 shadow-sm sm:p-6">
                  <h2 id={`about-${location.slug}`} className="text-lg font-semibold text-text-primary font-heading">
                    About {location.name}
                  </h2>
                  <dl className="mt-5 space-y-3.5 text-base">
                    <InfoRow label="Province" value={location.province} />
                    <InfoRow label="Elevation" value={`${location.elevation}m`} />
                    <InfoRow
                      label="Coordinates"
                      value={
                        <span className="font-mono text-base">
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
