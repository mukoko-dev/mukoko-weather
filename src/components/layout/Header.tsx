"use client";

import { lazy, Suspense, useState, useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
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
  const [isScrolled, setIsScrolled] = useState(false);

  // Scroll detection for dynamic header background
  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };

    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

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
        className={`sticky top-0 z-30 transition-all duration-300 ${
          isScrolled
            ? "bg-surface-base/70 backdrop-blur-xl border-b border-text-tertiary/10 shadow-sm"
            : ""
        }`}
        role="banner"
      >
        <nav aria-label="Primary navigation" className="mx-auto flex max-w-5xl items-center justify-between gap-2 px-4 py-3 sm:px-6 md:px-8">
          <div className="flex min-w-0 shrink items-center gap-4">
            <Link href="/" aria-label="mukoko weather — return to home page">
              <MukokoLogo className="text-[16px] sm:text-[20px]" />
            </Link>
          </div>

          {/* Action pill — solid primary background with white icons */}
          <div
            className="flex shrink-0 items-center gap-0.5 sm:gap-1 rounded-full bg-primary p-0.5 sm:p-1"
            role="toolbar"
            aria-label="Quick actions"
          >
            <button
              onClick={openMyWeather}
              aria-label="My Weather preferences"
              className="flex items-center justify-center w-9 h-9 sm:w-11 sm:h-11 rounded-full bg-background/10 hover:bg-background/20 transition-colors"
              type="button"
            >
              <MapPinIcon size={18} className="text-white" />
            </button>
            <Link
              href="/history"
              prefetch={false}
              aria-label="Weather history"
              className="flex items-center justify-center w-9 h-9 sm:w-11 sm:h-11 rounded-full bg-background/10 hover:bg-background/20 transition-colors"
            >
              <ClockIcon size={18} className="text-white" />
            </Link>
            <button
              onClick={openMyWeather}
              aria-label="Search locations"
              className="flex items-center justify-center w-9 h-9 sm:w-11 sm:h-11 rounded-full bg-background/10 hover:bg-background/20 transition-colors"
              type="button"
            >
              <SearchIcon size={18} className="text-white" />
            </button>
          </div>
        </nav>
      </header>

      {/* Mobile bottom navigation — visible only on small screens */}
      <nav
        aria-label="Mobile navigation"
        className="fixed bottom-0 left-0 right-0 z-30 border-t border-text-tertiary/10 bg-surface-base/95 backdrop-blur-xl sm:hidden"
      >
        <div className="mx-auto flex items-center justify-around h-16 px-2">
          <Link
            href="/"
            className={`flex flex-col items-center justify-center gap-0.5 px-3 py-2 rounded-xl transition-colors min-w-[60px] ${
              isHome ? "text-primary" : "text-text-tertiary"
            }`}
            aria-label="Weather home"
            aria-current={isHome ? "page" : undefined}
          >
            <HomeIcon size={20} />
            <span className="text-[10px] font-medium">Weather</span>
          </Link>
          <Link
            href="/explore"
            prefetch={false}
            className={`flex flex-col items-center justify-center gap-0.5 px-3 py-2 rounded-xl transition-colors min-w-[60px] ${
              isExplore ? "text-primary" : "text-text-tertiary"
            }`}
            aria-label="Explore locations"
            aria-current={isExplore ? "page" : undefined}
          >
            <CompassIcon size={20} />
            <span className="text-[10px] font-medium">Explore</span>
          </Link>
          <Link
            href="/history"
            prefetch={false}
            className={`flex flex-col items-center justify-center gap-0.5 px-3 py-2 rounded-xl transition-colors min-w-[60px] ${
              isHistory ? "text-primary" : "text-text-tertiary"
            }`}
            aria-label="Weather history"
            aria-current={isHistory ? "page" : undefined}
          >
            <ClockIcon size={20} />
            <span className="text-[10px] font-medium">History</span>
          </Link>
          <button
            onClick={openMyWeather}
            className="flex flex-col items-center justify-center gap-0.5 px-3 py-2 rounded-xl transition-colors min-w-[60px] text-text-tertiary"
            aria-label="My Weather settings"
            type="button"
          >
            <MapPinIcon size={20} />
            <span className="text-[10px] font-medium">My Weather</span>
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
