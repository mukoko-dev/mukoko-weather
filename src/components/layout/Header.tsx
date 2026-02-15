"use client";

import { lazy, Suspense, useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MukokoLogo } from "@/components/brand/MukokoLogo";
import { MapPinIcon, ClockIcon, SearchIcon } from "@/lib/weather-icons";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/lib/store";

// Code-split: MyWeatherModal imports LOCATIONS (154 items), ACTIVITIES (20 items),
// geolocation, router, etc. Lazy-loading prevents this from bloating the initial
// JS bundle, which is critical for iOS PWA memory limits.
const MyWeatherModal = lazy(() =>
  import("@/components/weather/MyWeatherModal").then((m) => ({
    default: m.MyWeatherModal,
  })),
);

function HomeIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
      <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function CompassIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
    </svg>
  );
}

export function Header() {
  const openMyWeather = useAppStore((s) => s.openMyWeather);
  const myWeatherOpen = useAppStore((s) => s.myWeatherOpen);
  const hasOnboarded = useAppStore((s) => s.hasOnboarded);
  const onboardingChecked = useRef(false);
  const pathname = usePathname();

  // Auto-open the My Weather modal for first-time visitors so they can
  // pick their location and activities. Runs once after Zustand rehydrates.
  useEffect(() => {
    if (onboardingChecked.current) return;
    onboardingChecked.current = true;
    if (!hasOnboarded) {
      // Small delay to let the page paint first
      const timer = setTimeout(openMyWeather, 500);
      return () => clearTimeout(timer);
    }
  }, [hasOnboarded, openMyWeather]);

  // Determine which mobile nav item is active based on pathname
  const isHome = pathname === "/" || (pathname !== "/explore" && pathname !== "/history" && !pathname.startsWith("/about") && !pathname.startsWith("/help") && !pathname.startsWith("/privacy") && !pathname.startsWith("/terms") && !pathname.startsWith("/status") && !pathname.startsWith("/embed"));
  const isExplore = pathname === "/explore" || pathname.startsWith("/explore/");
  const isHistory = pathname === "/history";

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
            <Button
              variant="ghost"
              size="icon"
              onClick={openMyWeather}
              aria-label="My Weather preferences"
              className="text-primary hover:bg-primary/15"
            >
              <MapPinIcon size={18} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              asChild
              className="text-primary hover:bg-primary/15"
            >
              <Link
                href="/history"
                prefetch={false}
                aria-label="Weather history"
              >
                <ClockIcon size={18} />
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={openMyWeather}
              aria-label="Search locations"
              className="text-primary hover:bg-primary/15"
            >
              <SearchIcon size={18} />
            </Button>
          </div>
        </nav>
      </header>

      {/* Mobile bottom navigation — visible only on small screens */}
      <nav
        aria-label="Mobile navigation"
        className="fixed bottom-0 left-0 right-0 z-30 border-t border-text-tertiary/10 bg-surface-base/95 backdrop-blur-md sm:hidden"
      >
        <div className="mx-auto flex max-w-5xl items-stretch justify-around">
          <Link
            href="/"
            className={`flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 text-xs transition-colors ${
              isHome ? "text-primary font-medium" : "text-text-tertiary"
            }`}
            aria-label="Weather home"
            aria-current={isHome ? "page" : undefined}
          >
            <HomeIcon size={20} />
            <span>Weather</span>
          </Link>
          <Link
            href="/explore"
            prefetch={false}
            className={`flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 text-xs transition-colors ${
              isExplore ? "text-primary font-medium" : "text-text-tertiary"
            }`}
            aria-label="Explore locations"
            aria-current={isExplore ? "page" : undefined}
          >
            <CompassIcon size={20} />
            <span>Explore</span>
          </Link>
          <Link
            href="/history"
            prefetch={false}
            className={`flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 text-xs transition-colors ${
              isHistory ? "text-primary font-medium" : "text-text-tertiary"
            }`}
            aria-label="Weather history"
            aria-current={isHistory ? "page" : undefined}
          >
            <ClockIcon size={20} />
            <span>History</span>
          </Link>
          <button
            onClick={openMyWeather}
            className="flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 text-xs text-text-tertiary transition-colors"
            aria-label="My Weather settings"
            type="button"
          >
            <MapPinIcon size={20} />
            <span>My Weather</span>
          </button>
        </div>
      </nav>

      {myWeatherOpen && (
        <Suspense>
          <MyWeatherModal />
        </Suspense>
      )}
    </>
  );
}
