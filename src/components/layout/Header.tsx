"use client";

import { lazy, Suspense, useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MukokoLogo } from "@/components/brand/MukokoLogo";
import { MapPinIcon, ClockIcon, SparklesIcon, MegaphoneIcon, LayersIcon } from "@/lib/weather-icons";
import { useAppStore } from "@/lib/store";

// Code-split: MyWeatherModal imports LOCATIONS (154 items), ACTIVITIES (20 items),
// geolocation, router, etc. Lazy-loading prevents this from bloating the initial
// JS bundle, which is critical for iOS PWA memory limits.
const MyWeatherModal = lazy(() =>
  import("@/components/weather/MyWeatherModal").then((m) => ({
    default: m.MyWeatherModal,
  })),
);

const WeatherReportModal = lazy(() =>
  import("@/components/weather/reports/WeatherReportModal").then((m) => ({
    default: m.WeatherReportModal,
  })),
);

function HomeIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
      <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function CompassIcon({ size = 22 }: { size?: number }) {
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
  const selectedLocation = useAppStore((s) => s.selectedLocation);
  const openReportModal = useAppStore((s) => s.openReportModal);
  const reportModalOpen = useAppStore((s) => s.reportModalOpen);
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

  // Determine which mobile nav item is active based on pathname
  const isShamwari = pathname === "/shamwari";
  const isExplore = pathname === "/explore" || pathname.startsWith("/explore/");
  const isHistory = pathname === "/history";
  const isHome = !isShamwari && !isExplore && !isHistory && !pathname.startsWith("/about") && !pathname.startsWith("/help") && !pathname.startsWith("/privacy") && !pathname.startsWith("/terms") && !pathname.startsWith("/status") && !pathname.startsWith("/embed");

  return (
    <>
      <header
        className={`sticky top-0 z-30 border-b transition-all duration-300 ${
          isScrolled
            ? "bg-surface-base/70 backdrop-blur-xl border-text-tertiary/10 shadow-sm"
            : "border-transparent"
        }`}
        role="banner"
      >
        <nav aria-label="Primary navigation" className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6 md:px-8">
          {/* Brand mark — icon + "weather" (Netflix-style icon recognition) */}
          <div className="flex flex-1 min-w-0 items-center sm:flex-none">
            <Link href="/" aria-label="mukoko weather — return to home page" className="mx-auto sm:mx-0">
              <MukokoLogo className="text-xl sm:text-2xl" />
            </Link>
          </div>

          {/* Desktop nav links — hidden on mobile where bottom nav is used */}
          <div className="hidden sm:flex items-center gap-1">
            <Link
              href="/explore"
              prefetch={false}
              className={`rounded-[var(--radius-input)] px-4 py-2.5 text-base font-medium transition-colors ${
                isExplore ? "text-primary bg-primary/10" : "text-text-secondary hover:text-text-primary hover:bg-surface-base"
              }`}
            >
              Explore
            </Link>
            <Link
              href="/shamwari"
              prefetch={false}
              className={`rounded-[var(--radius-input)] px-4 py-2.5 text-base font-medium transition-colors ${
                isShamwari ? "text-primary bg-primary/10" : "text-text-secondary hover:text-text-primary hover:bg-surface-base"
              }`}
            >
              Shamwari
            </Link>
            <Link
              href="/history"
              prefetch={false}
              className={`rounded-[var(--radius-input)] px-4 py-2.5 text-base font-medium transition-colors ${
                isHistory ? "text-primary bg-primary/10" : "text-text-secondary hover:text-text-primary hover:bg-surface-base"
              }`}
            >
              History
            </Link>
          </div>

          {/* Action pill — 3 quick actions: Maps, Report, My Weather */}
          {/* 56px touch targets (optimal), 20px icons for clarity */}
          <div
            className="flex shrink-0 items-center gap-1 rounded-full bg-primary p-1"
            role="toolbar"
            aria-label="Quick actions"
          >
            <Link
              href={`/${selectedLocation || "harare"}/map`}
              prefetch={false}
              aria-label="Weather map"
              className="flex items-center justify-center w-14 h-14 rounded-full bg-background/10 hover:bg-background/20 active:bg-background/30 active:scale-90 transition-all"
            >
              <LayersIcon size={20} className="text-primary-foreground" />
            </Link>
            <button
              onClick={openReportModal}
              aria-label="Report current weather"
              className="flex items-center justify-center w-14 h-14 rounded-full bg-background/10 hover:bg-background/20 active:bg-background/30 active:scale-90 transition-all"
              type="button"
            >
              <MegaphoneIcon size={20} className="text-primary-foreground" />
            </button>
            <button
              onClick={openMyWeather}
              aria-label="Open My Weather preferences"
              className="flex items-center justify-center w-14 h-14 rounded-full bg-background/10 hover:bg-background/20 active:bg-background/30 active:scale-90 transition-all"
              type="button"
            >
              <MapPinIcon size={20} className="text-primary-foreground" />
            </button>
          </div>
        </nav>
      </header>

      {/* Mobile bottom navigation — 5 items with Shamwari center */}
      {/* 56px min touch targets, 22px icons, 10px labels */}
      <nav
        aria-label="Mobile navigation"
        className="fixed bottom-0 left-0 right-0 z-40 border-t border-text-tertiary/10 bg-surface-base/95 backdrop-blur-xl sm:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      >
        <div className="mx-auto flex items-center justify-around px-1 min-h-[5rem]">
          <Link
            href="/"
            className={`relative flex flex-col items-center justify-center gap-0.5 px-2 py-2 rounded-xl transition-all min-w-[56px] min-h-[56px] active:scale-95 ${
              isHome ? "text-primary" : "text-text-tertiary hover:text-text-secondary"
            }`}
            aria-label="Weather home"
            aria-current={isHome ? "page" : undefined}
          >
            <HomeIcon size={22} />
            <span className="text-[10px] leading-tight font-medium truncate max-w-[56px]">Weather</span>
            {isHome && <span className="absolute bottom-1 h-0.5 w-5 rounded-full bg-primary" aria-hidden="true" />}
          </Link>
          <Link
            href="/explore"
            prefetch={false}
            className={`relative flex flex-col items-center justify-center gap-0.5 px-2 py-2 rounded-xl transition-all min-w-[56px] min-h-[56px] active:scale-95 ${
              isExplore ? "text-primary" : "text-text-tertiary hover:text-text-secondary"
            }`}
            aria-label="Explore locations"
            aria-current={isExplore ? "page" : undefined}
          >
            <CompassIcon size={22} />
            <span className="text-[10px] leading-tight font-medium truncate max-w-[56px]">Explore</span>
            {isExplore && <span className="absolute bottom-1 h-0.5 w-5 rounded-full bg-primary" aria-hidden="true" />}
          </Link>
          <Link
            href="/shamwari"
            prefetch={false}
            className={`relative flex flex-col items-center justify-center gap-0.5 px-2 py-2 rounded-xl transition-all min-w-[56px] min-h-[56px] active:scale-95 ${
              isShamwari ? "text-primary" : "text-text-tertiary hover:text-text-secondary"
            }`}
            aria-label="Shamwari AI assistant"
            aria-current={isShamwari ? "page" : undefined}
          >
            <SparklesIcon size={22} />
            <span className="text-[10px] leading-tight font-medium truncate max-w-[56px]">Shamwari</span>
            {isShamwari && <span className="absolute bottom-1 h-0.5 w-5 rounded-full bg-primary" aria-hidden="true" />}
          </Link>
          <Link
            href="/history"
            prefetch={false}
            className={`relative flex flex-col items-center justify-center gap-0.5 px-2 py-2 rounded-xl transition-all min-w-[56px] min-h-[56px] active:scale-95 ${
              isHistory ? "text-primary" : "text-text-tertiary hover:text-text-secondary"
            }`}
            aria-label="Weather history"
            aria-current={isHistory ? "page" : undefined}
          >
            <ClockIcon size={22} />
            <span className="text-[10px] leading-tight font-medium truncate max-w-[56px]">History</span>
            {isHistory && <span className="absolute bottom-1 h-0.5 w-5 rounded-full bg-primary" aria-hidden="true" />}
          </Link>
          <button
            onClick={openMyWeather}
            className="relative flex flex-col items-center justify-center gap-0.5 px-2 py-2 rounded-xl transition-all min-w-[56px] min-h-[56px] text-text-tertiary hover:text-text-secondary active:scale-95"
            aria-label="My Weather settings"
            type="button"
          >
            <MapPinIcon size={22} />
            <span className="text-[10px] leading-tight font-medium truncate max-w-[56px]">My Weather</span>
          </button>
        </div>
      </nav>

      {myWeatherOpen && (
        <Suspense>
          <MyWeatherModal />
        </Suspense>
      )}

      {reportModalOpen && (
        <Suspense>
          <WeatherReportModal />
        </Suspense>
      )}
    </>
  );
}
