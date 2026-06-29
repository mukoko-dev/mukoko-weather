"use client";

import { lazy, Suspense, useEffect, useState } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { CurrentConditions } from "@/components/weather/CurrentConditions";
import { AtmosphericSummary } from "@/components/weather/AtmosphericSummary";
import { HourlyScrollCards } from "@/components/weather/HourlyScrollCards";
import { SeasonBadge } from "@/components/weather/SeasonBadge";
import { LazySection } from "@/components/weather/LazySection";
import { ChartErrorBoundary } from "@/components/weather/ChartErrorBoundary";
import {
  SectionSkeleton,
  ReportsSkeleton,
  HourlyForecastSkeleton,
  ActivityInsightsSkeleton,
  DailyForecastSkeleton,
  AISummarySkeleton,
  AISummaryChatSkeleton,
  SunTimesSkeleton,
  MapPreviewSkeleton,
  SupportBannerSkeleton,
  LocationInfoSkeleton,
} from "@/components/weather/SectionSkeleton";
import { FrostAlertBanner } from "./FrostAlertBanner";
import { WeatherUnavailableBanner } from "./WeatherUnavailableBanner";
import { useAppStore } from "@/lib/store";
import type { WeatherData, FrostAlert, Season } from "@/lib/weather";
import type { WeatherLocation } from "@/lib/locations";
import { type Activity, ACTIVITIES } from "@/lib/activities";
import { InfoRow } from "@/components/ui/info-row";
import { SupportBanner } from "@/components/weather/SupportBanner";
import { DraggableSection } from "@/components/weather/DraggableSection";
import { LiveClock } from "@/components/weather/LiveClock";
import { getIcaoForSlug } from "@/lib/icao-codes";
import { cacheWeatherHint } from "@/lib/weather-scenes";

// ── Code-split heavy components ─────────────────────────────────────────────
// These use React.lazy() so their JS chunks (Chart.js, ReactMarkdown, etc.)
// are only downloaded when the LazySection IntersectionObserver fires.
// This dramatically reduces the initial JS parse/compile on iOS PWA.
const HourlyForecast = lazy(() => import("@/components/weather/HourlyForecast").then((m) => ({ default: m.HourlyForecast })));
const DailyForecast = lazy(() => import("@/components/weather/DailyForecast").then((m) => ({ default: m.DailyForecast })));
const AISummary = lazy(() => import("@/components/weather/AISummary").then((m) => ({ default: m.AISummary })));
const ActivityInsights = lazy(() => import("@/components/weather/ActivityInsights").then((m) => ({ default: m.ActivityInsights })));
const SunTimes = lazy(() => import("@/components/weather/SunTimes").then((m) => ({ default: m.SunTimes })));
const MapPreview = lazy(() => import("@/components/weather/map/MapPreview").then((m) => ({ default: m.MapPreview })));
const AviationWeather = lazy(() => import("@/components/weather/AviationWeather").then((m) => ({ default: m.AviationWeather })));
const AISummaryChat = lazy(() => import("@/components/weather/AISummaryChat").then((m) => ({ default: m.AISummaryChat })));
const RecentReports = lazy(() => import("@/components/weather/reports/RecentReports").then((m) => ({ default: m.RecentReports })));

import { formatCoords } from "@/lib/utils";

const BASE_URL = "https://weather.mukoko.com";

interface WeatherDashboardProps {
  weather: WeatherData;
  location: WeatherLocation;
  usingFallback: boolean;
  frostAlert: FrostAlert | null;
  season: Season;
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
  const sectionOrder = useAppStore((s) => s.sectionOrder);
  const setSectionOrder = useAppStore((s) => s.setSectionOrder);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);
  const icao = getIcaoForSlug(location.slug);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = sectionOrder.indexOf(active.id as string);
      const newIndex = sectionOrder.indexOf(over.id as string);
      if (oldIndex !== -1 && newIndex !== -1) {
        setSectionOrder(arrayMove(sectionOrder, oldIndex, newIndex));
      }
    }
  }

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

      {/* Breadcrumb navigation — always three layers: Country / Province / Location */}
      <nav aria-label="Breadcrumb" className="mx-auto max-w-7xl px-4 pt-3 sm:px-6 md:px-8">
        <ol className="flex flex-wrap items-center gap-1.5 text-base text-text-tertiary">
          <li>
            <a href={BASE_URL} className="hover:text-text-secondary transition-colors focus-visible:outline-2 focus-visible:outline-primary focus-visible:rounded">
              Home
            </a>
          </li>
          <li aria-hidden="true">/</li>
          {/* Country — always shown */}
          {countryName && (
            <>
              <li>
                <span className="text-text-secondary">{countryName}</span>
              </li>
              <li aria-hidden="true">/</li>
            </>
          )}
          {/* Province — skip only if identical to location name */}
          {location.province && location.province !== location.name && (
            <>
              <li>
                <span className="text-text-secondary">{location.province}</span>
              </li>
              <li aria-hidden="true">/</li>
            </>
          )}
          <li aria-current="page">
            <span className="font-medium text-text-primary">{location.name}</span>
          </li>
        </ol>
      </nav>

      <LiveClock />

      {/* pb-24 reserves space on mobile for a future sticky bottom nav bar;
          sm:pb-6 restores normal padding on larger screens where there is no nav bar. */}
      <main
        id="main-content"
        className="animate-fade-in mx-auto max-w-7xl overflow-x-hidden px-4 py-5 pb-20 sm:px-6 sm:pb-6 md:px-8"
        aria-label={`Weather dashboard for ${location.name}`}
      >
        {/* H1 for SEO — visually integrated but semantically correct */}
        <h1 className="sr-only">{location.name} Weather Forecast — Current Conditions and 7-Day Outlook</h1>

        {/* Screen reader announcement for loading→loaded transition (WCAG) */}
        <div aria-live="polite" className="sr-only">
          Weather loaded for {location.name}
        </div>

        {/* Season indicator */}
        <div className="mb-3">
          <SeasonBadge season={season} />
        </div>

        {/* Weather unavailable banner — shown when all providers failed */}
        {usingFallback && <WeatherUnavailableBanner />}

        {/* Frost alert banner */}
        {frostAlert && <FrostAlertBanner alert={frostAlert} />}

        {/* Customise layout toggle */}
        <div className="mb-3 flex justify-end">
          {reordering ? (
            <button
              type="button"
              onClick={() => setReordering(false)}
              className="press-scale inline-flex min-h-[var(--touch-target-min)] items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground transition-all hover:bg-primary/90"
            >
              Done
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setReordering(true)}
              className="press-scale inline-flex min-h-[var(--touch-target-min)] items-center gap-1.5 rounded-full border border-text-tertiary/20 px-3 py-1 text-sm text-text-tertiary transition-all hover:border-text-tertiary/40 hover:text-text-secondary"
              aria-label="Customise section layout"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M5 3a1 1 0 100 2 1 1 0 000-2zm6 0a1 1 0 100 2 1 1 0 000-2zM5 7a1 1 0 100 2 1 1 0 000-2zm6 0a1 1 0 100 2 1 1 0 000-2zM5 11a1 1 0 100 2 1 1 0 000-2zm6 0a1 1 0 100 2 1 1 0 000-2z" />
              </svg>
              Customise layout
            </button>
          )}
        </div>

        {/* Main grid: mobile = 1 col, lg = 3 col (2+1), xl = 4 col (3+1) */}
        <div className="grid gap-4 lg:grid-cols-3 lg:gap-6 xl:grid-cols-4">
          {/* Primary content — lg:col-span-2, xl:col-span-3, DnD sortable */}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={sectionOrder} strategy={verticalListSortingStrategy}>
              <div className="min-w-0 space-y-4 lg:col-span-2 xl:col-span-3">
                {sectionOrder.map((sectionId) => {
                  switch (sectionId) {
                    case "hourlyScroll":
                      return (
                        <DraggableSection key="hourlyScroll" id="hourlyScroll" reordering={reordering}>
                          <ChartErrorBoundary name="hourly scroll cards">
                            <HourlyScrollCards hourly={weather.hourly} />
                          </ChartErrorBoundary>
                        </DraggableSection>
                      );
                    case "current":
                      return (
                        <DraggableSection key="current" id="current" reordering={reordering}>
                          <ChartErrorBoundary name="current conditions">
                            <CurrentConditions
                              current={weather.current}
                              locationName={location.name}
                              daily={weather.daily}
                              slug={location.slug}
                            />
                          </ChartErrorBoundary>
                        </DraggableSection>
                      );
                    case "atmospheric":
                      return (
                        <DraggableSection key="atmospheric" id="atmospheric" reordering={reordering}>
                          <ChartErrorBoundary name="atmospheric conditions">
                            <AtmosphericSummary current={weather.current} />
                          </ChartErrorBoundary>
                        </DraggableSection>
                      );
                    case "reports":
                      return (
                        <DraggableSection key="reports" id="reports" reordering={reordering}>
                          <LazySection label="community-reports" fallback={<ReportsSkeleton />}>
                            <ChartErrorBoundary name="community reports">
                              <Suspense fallback={<ReportsSkeleton />}>
                                <RecentReports locationSlug={location.slug} />
                              </Suspense>
                            </ChartErrorBoundary>
                          </LazySection>
                        </DraggableSection>
                      );
                    case "hourlyForecast":
                      return (
                        <DraggableSection key="hourlyForecast" id="hourlyForecast" reordering={reordering}>
                          <LazySection label="hourly-forecast" fallback={<HourlyForecastSkeleton />}>
                            <ChartErrorBoundary name="hourly forecast">
                              <Suspense fallback={<HourlyForecastSkeleton />}>
                                <HourlyForecast hourly={weather.hourly} />
                              </Suspense>
                            </ChartErrorBoundary>
                          </LazySection>
                        </DraggableSection>
                      );
                    case "activityInsights":
                      return (
                        <DraggableSection key="activityInsights" id="activityInsights" reordering={reordering}>
                          <LazySection label="activity-insights" fallback={<ActivityInsightsSkeleton />}>
                            <ChartErrorBoundary name="activity insights">
                              <Suspense fallback={<ActivityInsightsSkeleton />}>
                                <ActivityInsights insights={weather.insights} activities={allActivities} />
                              </Suspense>
                            </ChartErrorBoundary>
                          </LazySection>
                        </DraggableSection>
                      );
                    case "dailyForecast":
                      return (
                        <DraggableSection key="dailyForecast" id="dailyForecast" reordering={reordering}>
                          <LazySection label="daily-forecast" fallback={<DailyForecastSkeleton />}>
                            <ChartErrorBoundary name="daily forecast">
                              <Suspense fallback={<DailyForecastSkeleton />}>
                                <DailyForecast daily={weather.daily} />
                              </Suspense>
                            </ChartErrorBoundary>
                          </LazySection>
                        </DraggableSection>
                      );
                    case "aiSummary":
                      return (
                        <DraggableSection key="aiSummary" id="aiSummary" reordering={reordering}>
                          <LazySection label="ai-summary" fallback={<AISummarySkeleton />}>
                            <ChartErrorBoundary name="AI summary">
                              <Suspense fallback={<AISummarySkeleton />}>
                                {!usingFallback && <AISummary weather={weather} location={location} onSummaryLoaded={setAiSummary} />}
                              </Suspense>
                            </ChartErrorBoundary>
                          </LazySection>
                        </DraggableSection>
                      );
                    case "aiChat":
                      return aiSummary && !usingFallback ? (
                        <DraggableSection key="aiChat" id="aiChat" reordering={reordering}>
                          <LazySection label="ai-followup-chat" fallback={<AISummaryChatSkeleton />}>
                            <ChartErrorBoundary name="AI follow-up chat">
                              <Suspense fallback={<AISummaryChatSkeleton />}>
                                <AISummaryChat
                                  weather={weather}
                                  location={location}
                                  initialSummary={aiSummary}
                                  season={`${season.localName} (${season.name})`}
                                />
                              </Suspense>
                            </ChartErrorBoundary>
                          </LazySection>
                        </DraggableSection>
                      ) : null;
                    default:
                      return null;
                  }
                })}
              </div>
            </SortableContext>
          </DndContext>

          {/* Sidebar — stacks below on mobile, col-span-1 on lg and xl */}
          <div className="min-w-0 space-y-4 lg:col-span-1 xl:col-span-1">
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

            {icao && (
              <LazySection label="aviation-weather" fallback={<SectionSkeleton />}>
                <ChartErrorBoundary name="aviation weather">
                  <Suspense fallback={<SectionSkeleton />}>
                    <AviationWeather slug={location.slug} icao={icao} />
                  </Suspense>
                </ChartErrorBoundary>
              </LazySection>
            )}

            <LazySection label="support-banner" fallback={<SupportBannerSkeleton />}>
              <ChartErrorBoundary name="support banner">
                <SupportBanner />
              </ChartErrorBoundary>
            </LazySection>

            {/* Location info card */}
            <LazySection label="location-info" fallback={<LocationInfoSkeleton />}>
              <section aria-labelledby={`about-${location.slug}`}>
                <div className="rounded-[var(--radius-card)] border border-primary/25 bg-surface-card p-4 shadow-sm">
                  <h2 id={`about-${location.slug}`} className="text-base font-semibold text-text-primary font-heading">
                    About {location.name}
                  </h2>
                  <dl className="mt-3 space-y-2 text-base">
                    {countryName && <InfoRow label="Country" value={countryName} />}
                    <InfoRow label="Province" value={location.province} />
                    <InfoRow label="Elevation" value={`${location.elevation}m`} />
                    <InfoRow
                      label="Coordinates"
                      value={
                        <span className="font-mono text-base">
                          {formatCoords(location.lat, location.lon)}
                        </span>
                      }
                    />
                    {location.nominatimAddress?.displayName && (
                      <InfoRow label="Address" value={location.nominatimAddress.displayName} />
                    )}
                    <InfoRow label="Season" value={`${season.localName} (${season.name})`} />
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
