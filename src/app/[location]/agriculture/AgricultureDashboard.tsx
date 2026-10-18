"use client";

import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { Breadcrumb } from "@/components/layout/Breadcrumb";
import { SeasonBadge } from "@/components/weather/SeasonBadge";
import { LazySection } from "@/components/weather/LazySection";
import { ChartErrorBoundary } from "@/components/weather/ChartErrorBoundary";
import {
  AgricultureSnapshotSkeleton,
  EnsoOutlookSkeleton,
  SectionSkeleton,
} from "@/components/weather/SectionSkeleton";
import { ChartSkeleton } from "@/components/ui/skeleton";
import { useAppStore } from "@/lib/store";
import {
  agricultureUrl,
  cropAdvice,
  farmingActivities,
  isAgricultureReady,
  locationMonth,
  type AgricultureResponse,
} from "@/lib/agriculture";
import { fetchAgriculture } from "@/lib/agriculture-client";
import type { WeatherLocation } from "@/lib/locations";
import type { Season } from "@/lib/weather";
import type { AISummaryUser } from "@/components/weather/AISummary";

const AgricultureSnapshot = lazy(() =>
  import("@/components/weather/AgricultureSnapshot").then((m) => ({
    default: m.AgricultureSnapshot,
  })),
);
const AgricultureCharts = lazy(() =>
  import("@/components/weather/AgricultureCharts").then((m) => ({
    default: m.AgricultureCharts,
  })),
);
const CropCalendarTable = lazy(() =>
  import("@/components/weather/CropCalendarTable").then((m) => ({
    default: m.CropCalendarTable,
  })),
);
const AgricultureCropAdvice = lazy(() =>
  import("@/components/weather/AgricultureCropAdvice").then((m) => ({
    default: m.AgricultureCropAdvice,
  })),
);
const AgricultureHistory = lazy(() =>
  import("@/components/weather/AgricultureHistory").then((m) => ({
    default: m.AgricultureHistory,
  })),
);
const AgricultureBriefing = lazy(() =>
  import("@/components/weather/AgricultureBriefing").then((m) => ({
    default: m.AgricultureBriefing,
  })),
);
const EnsoOutlook = lazy(() =>
  import("@/components/weather/EnsoOutlook").then((m) => ({
    default: m.EnsoOutlook,
  })),
);

interface Props {
  location: WeatherLocation;
  season: Season;
  user: AISummaryUser | null;
}

type Result =
  | { key: string; ok: true; value: AgricultureResponse }
  | { key: string; ok: false };

export function AgricultureDashboard({ location, season, user }: Props) {
  const selected = useAppStore((s) => s.selectedActivities);
  const crops = useMemo(() => farmingActivities(selected), [selected]);
  const url = agricultureUrl(location, crops);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    let live = true;
    fetchAgriculture(url)
      .then((value) => live && setResult({ key: url, ok: true, value }))
      .catch(() => live && setResult({ key: url, ok: false }));
    return () => {
      live = false;
    };
  }, [url]);

  const current = result?.key === url ? result : null;
  const data = current?.ok ? current.value : null;
  const ready = isAgricultureReady(data);
  const advice = useMemo(
    () => (data && ready ? cropAdvice(crops, data) : []),
    [data, ready, crops],
  );
  const month = locationMonth(data?.utcOffsetSeconds);
  const unavailable = current !== null && !ready;

  return (
    <>
      <Header />

      <Breadcrumb
        items={[
          { label: "Home", href: "/" },
          { label: location.name, href: `/${location.slug}` },
          { label: "Agriculture" },
        ]}
      />

      <main
        id="main-content"
        className="mx-auto max-w-5xl overflow-x-clip px-4 py-8 pb-[var(--mobile-nav-clearance)] sm:pb-8 sm:px-6 md:px-8"
        aria-label={`Agriculture insights for ${location.name}`}
      >
        <h1 className="text-2xl font-bold text-text-primary font-heading sm:text-3xl">
          {location.name} Agriculture
        </h1>
        <p className="mt-1 text-base text-text-secondary">
          {location.province} &middot; {location.elevation}m &middot;{" "}
          {data?.season
            ? `${data.season.localName} (${data.season.name})`
            : `${season.localName} (${season.name})`}
        </p>

        <div className="mt-4 mb-6">
          <SeasonBadge season={season} />
        </div>

        <div className="herd">
          <ChartErrorBoundary name="agriculture snapshot">
            <Suspense fallback={<AgricultureSnapshotSkeleton />}>
              <AgricultureSnapshot
                location={location}
                user={user}
                variant="page"
              />
            </Suspense>
          </ChartErrorBoundary>

          {unavailable && (
            <p role="status" className="acacia gazelle">
              Farm data is unavailable right now. Check back shortly; the
              location&apos;s forecast is still on its{" "}
              <Link href={`/${location.slug}/forecast`} className="sunbird">
                forecast page
              </Link>
              .
            </p>
          )}

          <LazySection
            label="agriculture-briefing"
            fallback={<SectionSkeleton />}
          >
            <ChartErrorBoundary name="agronomy briefing">
              <Suspense fallback={<SectionSkeleton />}>
                <AgricultureBriefing
                  location={location}
                  crops={crops}
                  user={user}
                  enabled={ready}
                />
              </Suspense>
            </ChartErrorBoundary>
          </LazySection>

          {ready && data && (
            <>
              <LazySection
                label="agriculture-crop-advice"
                fallback={<SectionSkeleton />}
              >
                <ChartErrorBoundary name="crop advice">
                  <Suspense fallback={<SectionSkeleton />}>
                    <AgricultureCropAdvice advice={advice} crops={crops} />
                  </Suspense>
                </ChartErrorBoundary>
              </LazySection>

              <LazySection
                label="agriculture-charts"
                fallback={<ChartSkeleton />}
              >
                <ChartErrorBoundary name="agriculture charts">
                  <Suspense fallback={<ChartSkeleton />}>
                    <AgricultureCharts daily={data.daily} />
                  </Suspense>
                </ChartErrorBoundary>
              </LazySection>

              <LazySection
                label="agriculture-calendar"
                fallback={<SectionSkeleton />}
              >
                <ChartErrorBoundary name="crop calendar">
                  <Suspense fallback={<SectionSkeleton />}>
                    <CropCalendarTable
                      calendar={data.calendar}
                      currentMonth={month}
                    />
                  </Suspense>
                </ChartErrorBoundary>
              </LazySection>

              <LazySection
                label="agriculture-history"
                fallback={<SectionSkeleton />}
              >
                <ChartErrorBoundary name="history against normals">
                  <Suspense fallback={<SectionSkeleton />}>
                    <AgricultureHistory
                      slug={location.slug}
                      lat={location.lat}
                      lon={location.lon}
                      modelRain30dMm={data.rain?.past30dMm ?? null}
                    />
                  </Suspense>
                </ChartErrorBoundary>
              </LazySection>
            </>
          )}

          <LazySection
            label="agriculture-enso"
            fallback={<EnsoOutlookSkeleton />}
          >
            <ChartErrorBoundary name="ENSO outlook">
              <Suspense fallback={<EnsoOutlookSkeleton />}>
                <EnsoOutlook
                  lat={location.lat}
                  lon={location.lon}
                  countryCode={location.country}
                />
              </Suspense>
            </ChartErrorBoundary>
          </LazySection>

          {data?.attribution && <p className="dove">{data.attribution}</p>}
        </div>
      </main>

      <Footer />
    </>
  );
}
