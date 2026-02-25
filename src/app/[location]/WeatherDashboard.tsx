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
import { WelcomeBanner } from "@/components/weather/WelcomeBanner";
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
  const openMyWeather = useAppStore((s) => s.openMyWeather);
  const selectedActivities = useAppStore((s) => s.selectedActivities);
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

        {/* Season indicator */}
        <div className="mb-5">
          <SeasonBadge season={season} />
        </div>

        {/* Weather unavailable banner — shown when all providers failed */}
        {usingFallback && <WeatherUnavailableBanner />}

        {/* Frost alert banner */}
        {frostAlert && <FrostAlertBanner alert={frostAlert} />}

        {/* Welcome banner for first-time visitors — inline, non-blocking */}
        <WelcomeBanner locationName={location.name} onChangeLocation={openMyWeather} />

        {/* Main grid — 3 children with CSS order for mobile reordering.
            Mobile: top→right→bottom (Daily right after Hourly)
            Tablet (md): 2 columns — top+right side-by-side, bottom below
            Desktop (lg): 3 columns — top+bottom stack in cols 1-2, right in col 3 */}
        <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-3 lg:gap-10">
          {/* Left-top: Current conditions + hourly forecast (eager) */}
          <div className="min-w-0 space-y-8 order-1 md:col-span-1 lg:col-span-2">
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
          </div>

          {/* Right column: Daily + Sun + Map + Reports + Info
              On mobile: shows SECOND (right after hourly, before AI/activities)
              On lg: positioned in the 3rd column, spanning both rows */}
          <div className="min-w-0 space-y-8 order-2 md:col-span-1 lg:row-span-2 lg:row-start-1 lg:col-start-3">
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

            <LazySection label="community-reports">
              <ChartErrorBoundary name="community reports">
                <Suspense fallback={<SectionSkeleton />}>
                  <RecentReports locationSlug={location.slug} />
                </Suspense>
              </ChartErrorBoundary>
            </LazySection>

            <LazySection label="support-banner">
              <ChartErrorBoundary name="support banner">
                <SupportBanner />
              </ChartErrorBoundary>
            </LazySection>

            {/* Location info card */}
            <LazySection label="location-info">
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

          {/* Left-bottom: AI + activities + atmospheric (lazy-loaded detail sections)
              On mobile: shows THIRD (after the right column)
              On lg: stacks below left-top in cols 1-2 */}
          <div className="min-w-0 space-y-8 order-3 md:col-span-2 lg:col-span-2">
            <LazySection label="ai-summary">
              <ChartErrorBoundary name="AI summary">
                <Suspense fallback={<SectionSkeleton />}>
                  {!usingFallback && <AISummary weather={weather} location={location} onSummaryLoaded={setAiSummary} />}
                </Suspense>
              </ChartErrorBoundary>
            </LazySection>
            {aiSummary && !usingFallback && (
              <LazySection label="ai-followup-chat">
                <ChartErrorBoundary name="AI follow-up chat">
                  <Suspense fallback={<SectionSkeleton />}>
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
        </div>
      </main>

      <Footer />
    </>
  );
}
