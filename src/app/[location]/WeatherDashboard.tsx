"use client";

import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { CurrentConditions } from "@/components/weather/CurrentConditions";
import { HourlyForecast } from "@/components/weather/HourlyForecast";
import { DailyForecast } from "@/components/weather/DailyForecast";
import { SunTimes } from "@/components/weather/SunTimes";
import { SeasonBadge } from "@/components/weather/SeasonBadge";
import { AISummary } from "@/components/weather/AISummary";
import { ActivityInsights } from "@/components/weather/ActivityInsights";
import { AtmosphericSummary } from "@/components/weather/AtmosphericSummary";
import { LazySection } from "@/components/weather/LazySection";
import { ChartErrorBoundary } from "@/components/weather/ChartErrorBoundary";
import { FrostAlertBanner } from "./FrostAlertBanner";
import { WeatherUnavailableBanner } from "./WeatherUnavailableBanner";
import { getZimbabweSeason } from "@/lib/weather";
import type { WeatherData, FrostAlert } from "@/lib/weather";
import type { ZimbabweLocation } from "@/lib/locations";

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
                {!usingFallback && <AISummary weather={weather} location={location} />}
              </ChartErrorBoundary>
            </LazySection>
            <LazySection>
              <ChartErrorBoundary name="activity insights">
                <ActivityInsights insights={weather.insights} />
              </ChartErrorBoundary>
            </LazySection>
            <LazySection>
              <ChartErrorBoundary name="hourly forecast">
                <HourlyForecast hourly={weather.hourly} />
              </ChartErrorBoundary>
            </LazySection>
            <LazySection>
              <ChartErrorBoundary name="atmospheric conditions">
                <AtmosphericSummary current={weather.current} />
              </ChartErrorBoundary>
            </LazySection>
          </div>

          {/* Right column: Daily + Sun + Info */}
          <div className="min-w-0 space-y-6">
            <LazySection>
              <ChartErrorBoundary name="daily forecast">
                <DailyForecast daily={weather.daily} />
              </ChartErrorBoundary>
            </LazySection>
            <LazySection>
              <ChartErrorBoundary name="sun times">
                <SunTimes daily={weather.daily} />
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
