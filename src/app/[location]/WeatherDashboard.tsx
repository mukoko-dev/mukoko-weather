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
  ActivityInsightsSkeleton,
  AISummarySkeleton,
  AISummaryChatSkeleton,
  MapPreviewSkeleton,
  SupportBannerSkeleton,
  LocationInfoSkeleton,
} from "@/components/weather/SectionSkeleton";
import { FrostAlertBanner } from "./FrostAlertBanner";
import { WeatherUnavailableBanner } from "./WeatherUnavailableBanner";
import { WelcomeBanner } from "@/components/weather/WelcomeBanner";
import { useAppStore } from "@/lib/store";
import type { WeatherData, FrostAlert, Season, MinutelyData, ModelForecast } from "@/lib/weather";
import { fetchWeather, COMPARISON_MODELS, synthesizeOpenMeteoInsights } from "@/lib/weather";
import type { WeatherLocation } from "@/lib/locations";
import type { AISummaryUser } from "@/components/weather/AISummary";
import { type Activity, ACTIVITIES } from "@/lib/activities";
import { InfoRow } from "@/components/ui/info-row";
import { SectionHeader } from "@/components/ui/section-header";
import { SupportBanner } from "@/components/weather/SupportBanner";
import { DraggableSection } from "@/components/weather/DraggableSection";
import { LiveClock } from "@/components/weather/LiveClock";
import { getIcaoForSlug, getNearestIcao, getNearestIcaos, fetchNearestAirports, type AirportDistance } from "@/lib/icao-codes";
import { cacheWeatherHint } from "@/lib/weather-scenes";

// ── Code-split heavy components ─────────────────────────────────────────────
// These use React.lazy() so their JS chunks (Chart.js, ReactMarkdown, etc.)
// are only downloaded when the LazySection IntersectionObserver fires.
// This dramatically reduces the initial JS parse/compile on iOS PWA.
const AISummary = lazy(() => import("@/components/weather/AISummary").then((m) => ({ default: m.AISummary })));
const ActivityInsights = lazy(() => import("@/components/weather/ActivityInsights").then((m) => ({ default: m.ActivityInsights })));
const MapPreview = lazy(() => import("@/components/weather/map/MapPreview").then((m) => ({ default: m.MapPreview })));
const AviationWeather = lazy(() => import("@/components/weather/AviationWeather").then((m) => ({ default: m.AviationWeather })));
const AISummaryChat = lazy(() => import("@/components/weather/AISummaryChat").then((m) => ({ default: m.AISummaryChat })));
const RecentReports = lazy(() => import("@/components/weather/reports/RecentReports").then((m) => ({ default: m.RecentReports })));
const MinutelyNowcast = lazy(() => import("@/components/weather/MinutelyNowcast").then((m) => ({ default: m.MinutelyNowcast })));
const ModelComparisonChart = lazy(() => import("@/components/weather/charts/ModelComparisonChart").then((m) => ({ default: m.ModelComparisonChart })));

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
  /**
   * Signed-in WorkOS user (id + email subset) or `null` when anonymous.
   * Drives the AI summary auth gate — anon users see a sign-in CTA in
   * place of the AI summary and follow-up chat.
   */
  user: AISummaryUser | null;
}

export function WeatherDashboard({
  weather,
  location,
  usingFallback,
  frostAlert,
  season,
  countryName,
  user,
}: WeatherDashboardProps) {
  const setSelectedLocation = useAppStore((s) => s.setSelectedLocation);
  const selectedActivities = useAppStore((s) => s.selectedActivities);
  const selectedForecastModel = useAppStore((s) => s.selectedForecastModel);
  const openMyWeather = useAppStore((s) => s.openMyWeather);
  const sectionOrder = useAppStore((s) => s.sectionOrder);
  const setSectionOrder = useAppStore((s) => s.setSectionOrder);
  const hydrateSectionOrder = useAppStore((s) => s.hydrateSectionOrder);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);
  // Windy-style ADDITIONAL data — multi-model comparison + minutely nowcast.
  // Fetched client-side from Open-Meteo (free, keyless) so it never blocks the
  // server-rendered base forecast. Re-fetched when the user changes model.
  const [minutely, setMinutely] = useState<MinutelyData | null>(null);
  const [modelSeries, setModelSeries] = useState<ModelForecast[]>([]);
  const [modelsTime, setModelsTime] = useState<string[]>([]);
  const icao = getIcaoForSlug(location.slug) ?? getNearestIcao(location.lat, location.lon);
  // Nearby stations the user can switch between in the aviation section.
  // Seeded with the static haversine scan (instant, works offline), then
  // upgraded to the DB-backed $nearSphere result once it resolves. If the DB
  // call fails, `fetchNearestAirports` already returns the static fallback.
  const [nearbyIcaos, setNearbyIcaos] = useState<AirportDistance[]>(() =>
    getNearestIcaos(location.lat, location.lon, 5),
  );
  useEffect(() => {
    let cancelled = false;
    // `fetchNearestAirports` prefers the DB $nearSphere result and already
    // falls back to the static haversine scan on failure, so whatever it
    // resolves is the best available list for the current coordinates.
    fetchNearestAirports(location.lat, location.lon, 5).then((airports) => {
      if (!cancelled && airports.length > 0) setNearbyIcaos(airports);
    });
    return () => {
      cancelled = true;
    };
  }, [location.lat, location.lon]);

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

  // Apply the persisted section order AFTER hydration. The store initialises to
  // DEFAULT_SECTION_ORDER on the server and first client render (so hydration
  // matches); this effect reads localStorage and applies the saved/reconciled
  // order once mounted, avoiding a React hydration mismatch + flash.
  useEffect(() => {
    hydrateSectionOrder();
  }, [hydrateSectionOrder]);

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

  // Fetch multi-model comparison + minutely nowcast from Open-Meteo. Best-effort
  // — failures are swallowed so the base page is never affected. The selected
  // model is unioned into the comparison set so the user's pick is always shown.
  useEffect(() => {
    let cancelled = false;
    const models = Array.from(new Set([selectedForecastModel, ...COMPARISON_MODELS]));
    fetchWeather(location.lat, location.lon, models)
      .then((data) => {
        if (cancelled) return;
        setMinutely(data.minutely ?? null);
        setModelSeries(data.models ?? []);
        setModelsTime(data.models_time ?? []);
      })
      .catch(() => {
        // Non-critical enhancement — leave sections hidden on failure.
      });
    return () => {
      cancelled = true;
    };
  }, [location.lat, location.lon, selectedForecastModel]);

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

      {/* Clock + customise layout — same row, no extra vertical space */}
      <div className="mx-auto max-w-7xl px-4 pt-1 pb-0 sm:px-6 md:px-8 flex items-center justify-between">
        <LiveClock />
        {reordering ? (
          <button type="button" onClick={() => setReordering(false)} className="kudu-sm">
            Done
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setReordering(true)}
            className="impala-sm"
            aria-label="Customise section layout"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M5 3a1 1 0 100 2 1 1 0 000-2zm6 0a1 1 0 100 2 1 1 0 000-2zM5 7a1 1 0 100 2 1 1 0 000-2zm6 0a1 1 0 100 2 1 1 0 000-2zM5 11a1 1 0 100 2 1 1 0 000-2zm6 0a1 1 0 100 2 1 1 0 000-2z" />
            </svg>
            Customise layout
          </button>
        )}
      </div>

      {/* pb-24 reserves space on mobile for a future sticky bottom nav bar;
          sm:pb-6 restores normal padding on larger screens where there is no nav bar. */}
      <main
        id="main-content"
        className="animate-fade-in mx-auto max-w-7xl overflow-x-hidden px-4 py-3 pb-20 sm:px-6 sm:pb-6 md:px-8"
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

        {/* Welcome banner — first-time visitors only, dismissed via its own buttons */}
        <WelcomeBanner locationName={location.name} onChangeLocation={openMyWeather} />

        {/* Weather unavailable banner — shown when all providers failed */}
        {usingFallback && <WeatherUnavailableBanner />}

        {/* Frost alert banner */}
        {frostAlert && <FrostAlertBanner alert={frostAlert} />}

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
                            <section aria-labelledby="hourly-scroll-heading">
                              <SectionHeader
                                headingId="hourly-scroll-heading"
                                title="Hourly"
                                action={{ label: "Full forecast →", href: `/${location.slug}/forecast` }}
                                className="mb-2"
                              />
                              <HourlyScrollCards hourly={weather.hourly} />
                            </section>
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
                            <AtmosphericSummary
                              current={weather.current}
                              lat={location.lat}
                              lon={location.lon}
                            />
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
                    case "activityInsights":
                      return (
                        <DraggableSection key="activityInsights" id="activityInsights" reordering={reordering}>
                          <LazySection label="activity-insights" fallback={<ActivityInsightsSkeleton />}>
                            <ChartErrorBoundary name="activity insights">
                              <Suspense fallback={<ActivityInsightsSkeleton />}>
                                {/* Insights synthesized from the base forecast when the provider
                                    (Open-Meteo fallback) doesn't supply them — activity cards
                                    must never render without data. */}
                                <ActivityInsights insights={weather.insights ?? synthesizeOpenMeteoInsights(weather)} activities={allActivities} weather={weather} />
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
                                {!usingFallback && <AISummary weather={weather} location={location} user={user} onSummaryLoaded={setAiSummary} />}
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
                                  user={user}
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
                    <AviationWeather slug={location.slug} icao={icao} nearby={nearbyIcaos} />
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
                <div className="baobab">
                  <h2 id={`about-${location.slug}`} className="giraffe">
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

        {/* Windy-style additions — full width, only when Open-Meteo returned data */}
        {minutely && (
          <div className="mt-4">
            <LazySection label="minutely-nowcast" fallback={<SectionSkeleton />}>
              <ChartErrorBoundary name="minutely nowcast">
                <Suspense fallback={<SectionSkeleton />}>
                  <MinutelyNowcast minutely={minutely} />
                </Suspense>
              </ChartErrorBoundary>
            </LazySection>
          </div>
        )}

        {modelSeries.length > 0 && modelsTime.length > 0 && (
          <div className="mt-4">
            <LazySection label="model-comparison" fallback={<SectionSkeleton />}>
              <ChartErrorBoundary name="model comparison">
                <Suspense fallback={<SectionSkeleton />}>
                  <ModelComparisonChart models={modelSeries} time={modelsTime} />
                </Suspense>
              </ChartErrorBoundary>
            </LazySection>
          </div>
        )}
      </main>

      <Footer />
    </>
  );
}
