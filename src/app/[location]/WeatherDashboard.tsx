"use client";

import { lazy, Suspense } from "react";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { CurrentConditions } from "@/components/weather/CurrentConditions";
import { SeasonBadge } from "@/components/weather/SeasonBadge";
import { LazySection } from "@/components/weather/LazySection";
import { ChartErrorBoundary } from "@/components/weather/ChartErrorBoundary";
import { FrostAlertBanner } from "./FrostAlertBanner";
import { WeatherUnavailableBanner } from "./WeatherUnavailableBanner";
import { getZimbabweSeason } from "@/lib/weather";
import type { WeatherData, FrostAlert } from "@/lib/weather";
import type { ZimbabweLocation } from "@/lib/locations";

// ── Code-split heavy components ─────────────────────────────────────────────
// These use React.lazy() so their JS chunks (Recharts, ReactMarkdown, etc.)
// are only downloaded when the LazySection IntersectionObserver fires.
// This dramatically reduces the initial JS parse/compile on iOS PWA.
const HourlyForecast = lazy(() => import("@/components/weather/HourlyForecast").then((m) => ({ default: m.HourlyForecast })));
const DailyForecast = lazy(() => import("@/components/weather/DailyForecast").then((m) => ({ default: m.DailyForecast })));
const AISummary = lazy(() => import("@/components/weather/AISummary").then((m) => ({ default: m.AISummary })));
const ActivityInsights = lazy(() => import("@/components/weather/ActivityInsights").then((m) => ({ default: m.ActivityInsights })));
const AtmosphericSummary = lazy(() => import("@/components/weather/AtmosphericSummary").then((m) => ({ default: m.AtmosphericSummary })));
const SunTimes = lazy(() => import("@/components/weather/SunTimes").then((m) => ({ default: m.SunTimes })));

/** Lightweight placeholder while a lazy chunk loads */
function SectionSkeleton() {
  return <div className="h-32 animate-pulse rounded-[var(--radius-card)] bg-surface-card" />;
}

const BASE_URL = "https://weather.mukoko.com";

interface WeatherDashboardProps {
  weather: WeatherData;
  location: ZimbabweLocation;
  usingFallback: boolean;
  frostAlert: FrostAlert | null;
}

export function WeatherDashboard({
  weather,
  location,
  usingFallback,
  frostAlert,
}: WeatherDashboardProps) {
  const season = getZimbabweSeason();

  return (
    <>
      <Header />

      {/* Breadcrumb navigation for SEO and accessibility */}
      <nav aria-label="Breadcrumb" className="mx-auto max-w-5xl px-4 pt-4 sm:pl-6 md:pl-8">
        <ol className="flex items-center gap-1 text-xs text-text-tertiary">
          <li>
            <a href={BASE_URL} className="hover:text-text-secondary transition-colors focus-visible:outline-2 focus-visible:outline-primary focus-visible:rounded">
              Home
            </a>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <span className="text-text-secondary">{location.province}</span>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page">
            <span className="font-medium text-text-primary">{location.name}</span>
          </li>
        </ol>
      </nav>

      <main
        id="main-content"
        className="mx-auto max-w-5xl overflow-hidden px-4 py-6 sm:pl-6 md:pl-8"
        aria-label={`Weather dashboard for ${location.name}`}
      >
        {/* H1 for SEO — visually integrated but semantically correct */}
        <h1 className="sr-only">{location.name} Weather Forecast — Current Conditions and 7-Day Outlook</h1>

        {/* Season indicator */}
        <div className="mb-4">
          <SeasonBadge />
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
              />
            </ChartErrorBoundary>
            <LazySection>
              <ChartErrorBoundary name="AI summary">
                <Suspense fallback={<SectionSkeleton />}>
                  {!usingFallback && <AISummary weather={weather} location={location} />}
                </Suspense>
              </ChartErrorBoundary>
            </LazySection>
            <LazySection>
              <ChartErrorBoundary name="activity insights">
                <Suspense fallback={<SectionSkeleton />}>
                  <ActivityInsights insights={weather.insights} />
                </Suspense>
              </ChartErrorBoundary>
            </LazySection>
            <LazySection>
              <ChartErrorBoundary name="hourly forecast">
                <Suspense fallback={<SectionSkeleton />}>
                  <HourlyForecast hourly={weather.hourly} />
                </Suspense>
              </ChartErrorBoundary>
            </LazySection>
            <LazySection>
              <ChartErrorBoundary name="atmospheric conditions">
                <Suspense fallback={<SectionSkeleton />}>
                  <AtmosphericSummary current={weather.current} />
                </Suspense>
              </ChartErrorBoundary>
            </LazySection>
          </div>

          {/* Right column: Daily + Sun + Info */}
          <div className="min-w-0 space-y-6">
            <LazySection>
              <ChartErrorBoundary name="daily forecast">
                <Suspense fallback={<SectionSkeleton />}>
                  <DailyForecast daily={weather.daily} />
                </Suspense>
              </ChartErrorBoundary>
            </LazySection>
            <LazySection>
              <ChartErrorBoundary name="sun times">
                <Suspense fallback={<SectionSkeleton />}>
                  <SunTimes daily={weather.daily} />
                </Suspense>
              </ChartErrorBoundary>
            </LazySection>

            {/* Location info card */}
            <LazySection>
              <section aria-labelledby={`about-${location.slug}`}>
                <div className="rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm sm:p-6">
                  <h2 id={`about-${location.slug}`} className="text-lg font-semibold text-text-primary font-heading">
                    About {location.name}
                  </h2>
                  <dl className="mt-4 space-y-3 text-sm">
                    <div className="flex justify-between">
                      <dt className="text-text-secondary">Province</dt>
                      <dd className="font-medium text-text-primary">{location.province}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-text-secondary">Elevation</dt>
                      <dd className="font-medium text-text-primary">{location.elevation}m</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-text-secondary">Coordinates</dt>
                      <dd className="font-mono text-xs text-text-primary">
                        {location.lat.toFixed(2)}, {location.lon.toFixed(2)}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-text-secondary">Season</dt>
                      <dd className="font-medium text-text-primary">
                        {season.shona} ({season.name})
                      </dd>
                    </div>
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
