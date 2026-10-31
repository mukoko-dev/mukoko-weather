"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { type DeviceView, slugFromLocationPath } from "@/lib/device-weather";
import { recallPlace } from "@/lib/rxdb/weather-places";
import { Header } from "@/components/layout/Header";
import { CurrentConditions } from "@/components/weather/CurrentConditions";
import { HourlyScrollCards } from "@/components/weather/HourlyScrollCards";
import { DailyForecast } from "@/components/weather/DailyForecast";
import { SeasonBadge } from "@/components/weather/SeasonBadge";
import { WeatherBackdrop } from "@/components/weather/WeatherBackdrop";
import { ChartErrorBoundary } from "@/components/weather/ChartErrorBoundary";
import { UpdatedAgo } from "@/components/weather/UpdatedAgo";
import { WeatherLoadingScene } from "@/components/weather/WeatherLoadingScene";
import { FrostAlertBanner } from "@/app/[location]/FrostAlertBanner";
import { SECTION_STACK_CLASS } from "@/lib/dashboard-layout";

/**
 * A place's weather painted from the device — the above-the-fold part of the
 * location page (hero, hourly strip, days) with no network sections. Shown
 * while the live page is on its way, and on the offline page.
 */
export function DeviceSnapshot({
  view,
  showHeader = true,
}: {
  view: DeviceView;
  showHeader?: boolean;
}) {
  const { location, weather, season, frostAlert } = view.payload;
  return (
    <>
      <WeatherBackdrop
        weatherCode={weather.current.weather_code}
        windSpeed={weather.current.wind_speed_10m}
        isDay={weather.current.is_day === 1}
      />
      <div className="relative z-10">
        {showHeader && <Header />}
        <main
          id="main-content"
          className="mx-auto max-w-7xl overflow-x-hidden px-4 pt-[var(--space-section)] pb-[var(--mobile-nav-clearance)] sm:px-6 sm:pb-6 md:px-8"
          aria-label={`Weather dashboard for ${location.name} (saved on this device)`}
          data-device-snapshot={location.slug}
        >
          <h1 className="sr-only">
            {location.name} weather, saved on this device
          </h1>
          <UpdatedAgo
            fetchedAt={view.fetchedAt}
            freshness={view.freshness}
            weather={weather}
            placeName={location.name}
          />
          {frostAlert && <FrostAlertBanner alert={frostAlert} />}
          <div className={SECTION_STACK_CLASS}>
            <ChartErrorBoundary name="current conditions">
              <CurrentConditions
                current={weather.current}
                locationName={location.name}
                daily={weather.daily}
                hourly={weather.hourly}
                utcOffsetSeconds={weather.utc_offset_seconds}
                slug={location.slug}
              />
            </ChartErrorBoundary>
            <ChartErrorBoundary name="hourly scroll cards">
              <section aria-labelledby="device-hourly-heading">
                <HourlyScrollCards
                  hourly={weather.hourly}
                  utcOffsetSeconds={weather.utc_offset_seconds}
                  variant="sky"
                  footer={<SeasonBadge season={season} />}
                  heading={{
                    headingId: "device-hourly-heading",
                    title: "Conditions",
                  }}
                />
              </section>
            </ChartErrorBoundary>
            <ChartErrorBoundary name="daily forecast">
              <section aria-labelledby="device-daily-heading">
                <h2
                  id="device-daily-heading"
                  className="giraffe mb-[var(--space-stack)]"
                >
                  Next days
                </h2>
                <DailyForecast daily={weather.daily} />
              </section>
            </ChartErrorBoundary>
          </div>
        </main>
      </div>
    </>
  );
}

/**
 * The `[location]` loading boundary: paints the stored copy of this place at
 * once when the device has one, else the branded loading scene. The live
 * page replaces it as soon as it streams in.
 */
export function DeviceLocationLoading() {
  const pathname = usePathname();
  const slug = slugFromLocationPath(pathname);
  // undefined = still looking; null = nothing stored.
  const [view, setView] = useState<DeviceView | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    if (!slug) return;
    recallPlace(slug)
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch(() => {
        if (!cancelled) setView(null);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (view) return <DeviceSnapshot view={view} />;
  return <WeatherLoadingScene />;
}
