"use client";

import { lazy, Suspense } from "react";
import Link from "next/link";
import { MukokoLogo } from "@/components/brand/MukokoLogo";
import { MapPinIcon, ClockIcon, SearchIcon } from "@/lib/weather-icons";
import { useAppStore } from "@/lib/store";

// Code-split: MyWeatherModal imports LOCATIONS (154 items), ACTIVITIES (20 items),
// geolocation, router, etc. Lazy-loading prevents this from bloating the initial
// JS bundle, which is critical for iOS PWA memory limits.
const MyWeatherModal = lazy(() =>
  import("@/components/weather/MyWeatherModal").then((m) => ({
    default: m.MyWeatherModal,
  })),
);

export function Header() {
  const openMyWeather = useAppStore((s) => s.openMyWeather);
  const myWeatherOpen = useAppStore((s) => s.myWeatherOpen);

  return (
    <>
      <header
        className="sticky top-0 z-30 border-b border-text-tertiary/10 bg-surface-base/80 backdrop-blur-md"
        role="banner"
      >
        <nav aria-label="Primary navigation" className="mx-auto flex max-w-5xl items-center justify-between gap-2 px-4 py-3 sm:pl-6 md:pl-8">
          <div className="flex min-w-0 shrink items-center gap-4">
            <Link href="/" aria-label="mukoko weather — return to home page">
              <MukokoLogo className="text-lg sm:text-xl" />
            </Link>
          </div>
          <div
            className="flex shrink-0 items-center gap-0.5 rounded-[var(--radius-badge)] bg-primary/10 p-1"
            role="toolbar"
            aria-label="Quick actions"
          >
            <button
              onClick={openMyWeather}
              className="flex h-10 w-10 items-center justify-center rounded-full text-primary transition-colors hover:bg-primary/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              aria-label="My Weather preferences"
              type="button"
            >
              <MapPinIcon size={18} />
            </button>
            <Link
              href="/history"
              prefetch={false}
              className="flex h-10 w-10 items-center justify-center rounded-full text-primary transition-colors hover:bg-primary/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              aria-label="Weather history"
            >
              <ClockIcon size={18} />
            </Link>
            <button
              onClick={openMyWeather}
              className="flex h-10 w-10 items-center justify-center rounded-full text-primary transition-colors hover:bg-primary/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              aria-label="Search locations"
              type="button"
            >
              <SearchIcon size={18} />
            </button>
          </div>
        </nav>
      </header>
      {myWeatherOpen && (
        <Suspense>
          <MyWeatherModal />
        </Suspense>
      )}
    </>
  );
}
