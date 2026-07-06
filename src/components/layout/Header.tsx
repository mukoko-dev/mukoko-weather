"use client";

import { lazy, Suspense, useState, useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { MukokoLogo } from "@/components/brand/MukokoLogo";
import { MapPinIcon, ClockIcon, SparklesIcon, LayersIcon, BellIcon, UserIcon } from "@/lib/weather-icons";
import { useAppStore } from "@/lib/store";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { initialsFor, type PublicUser } from "@/lib/user-display";

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
  const reportModalOpen = useAppStore((s) => s.reportModalOpen);
  const pathname = usePathname();
  const [isScrolled, setIsScrolled] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const notificationsRef = useRef<HTMLDivElement>(null);
  const bellButtonRef = useRef<HTMLButtonElement>(null);
  // AuthKit's `useAuth()` is hydrated via `<AuthKitProvider initialAuth={…}>`
  // in the root layout, so this renders with the right state on first paint.
  const { user } = useAuth();
  const authedUser = user as PublicUser | null;

  // Scroll detection for dynamic header background
  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };

    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // Dismiss the notifications popover on outside click or Escape. Escape also
  // returns focus to the bell button so keyboard users aren't stranded.
  useEffect(() => {
    if (!notificationsOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (notificationsRef.current && !notificationsRef.current.contains(e.target as Node)) {
        setNotificationsOpen(false);
      }
    };
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setNotificationsOpen(false);
        bellButtonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeydown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeydown);
    };
  }, [notificationsOpen]);

  // Determine which mobile nav item is active based on pathname
  const isExplore = pathname === "/explore" || pathname.startsWith("/explore/");
  const isHistory = pathname === "/history";
  const isAviation = pathname === "/aviation";
  const isHome = !isExplore && !isHistory && !isAviation && !pathname.startsWith("/about") && !pathname.startsWith("/help") && !pathname.startsWith("/privacy") && !pathname.startsWith("/terms") && !pathname.startsWith("/status") && !pathname.startsWith("/embed") && !pathname.startsWith("/shamwari");
  const shamwariEnabled = isFeatureEnabled("shamwari_chat");

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
        <nav aria-label="Primary navigation" className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6 md:px-8">
          {/* Brand mark — icon + "weather" (Netflix-style icon recognition) */}
          <div className="flex flex-1 min-w-0 items-center sm:flex-none">
            <Link
              href="/"
              aria-label="mukoko weather — return to home page"
              className="mx-auto sm:mx-0 flex items-center"
            >
              <MukokoLogo />
            </Link>
          </div>

          {/* Desktop nav — plain text links, underline on active/hover */}
          <nav className="hidden sm:flex items-center gap-6" aria-label="Main navigation">
            {[
              { href: "/explore", label: "Explore", active: isExplore },
              // Paused as a standalone destination — see FLAGS.shamwari_chat.
              ...(shamwariEnabled ? [{ href: "/shamwari", label: "Shamwari", active: pathname === "/shamwari" }] : []),
              { href: "/history", label: "History", active: isHistory },
              { href: "/aviation", label: "Aviation", active: isAviation },
            ].map(({ href, label, active }) => (
              <Link
                key={href}
                href={href}
                prefetch={false}
                aria-current={active ? "page" : undefined}
                className={active ? "weaver-active" : "weaver"}
              >
                {label}
              </Link>
            ))}
            {/* My Weather opens a modal (not a route), so it's a button rather
                than a Link, but styled identically to the other nav items. It
                lives outside the icon group below — that group is reserved
                for map / notifications / account, and My Weather must stay
                reachable for anonymous desktop users too (mobile keeps its
                own separate bottom-nav entry, unaffected). */}
            <button type="button" onClick={openMyWeather} className="weaver">
              My Weather
            </button>
          </nav>

          {/* Action pill — map, notifications, account. Sign-in/avatar lives
              inside the group (not floating separately) and routes straight
              to sign-in or the profile page — no dropdown menu. */}
          {/* 44px buttons, 18px icons — compact desktop pill */}
          <div className="flex shrink-0 items-center gap-2">
            <div
              className="flex items-center gap-0.5 rounded-full bg-primary p-0.5"
              role="toolbar"
              aria-label="Quick actions"
            >
              <Link
                href={`/${selectedLocation || "harare"}/map`}
                prefetch={false}
                aria-label="Weather map"
                className="bee"
              >
                <LayersIcon size={20} className="text-primary-foreground" />
              </Link>

              <div className="relative" ref={notificationsRef}>
                <button
                  ref={bellButtonRef}
                  onClick={() => setNotificationsOpen((v) => !v)}
                  aria-label="Notifications"
                  aria-haspopup="dialog"
                  aria-expanded={notificationsOpen}
                  className="bee"
                  type="button"
                >
                  <BellIcon size={20} className="text-primary-foreground" />
                </button>
                {notificationsOpen && (
                  <div
                    role="dialog"
                    aria-label="Notifications"
                    className="absolute right-0 top-full z-40 mt-2 w-64 rounded-[var(--radius-card)] border border-text-tertiary/10 bg-surface-card p-4 shadow-lg"
                  >
                    <p className="dove" aria-live="polite">
                      No notifications yet
                    </p>
                  </div>
                )}
              </div>

              {authedUser ? (
                <Link
                  href="/profile"
                  aria-label={`Profile${authedUser.email ? ` (${authedUser.email})` : ""}`}
                  className="bee overflow-hidden"
                >
                  {authedUser.profilePictureUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={authedUser.profilePictureUrl}
                      alt=""
                      className="h-full w-full object-cover"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <span className="text-xs font-medium text-primary-foreground" aria-hidden="true">
                      {initialsFor(authedUser)}
                    </span>
                  )}
                </Link>
              ) : (
                <Link href="/auth/signin" prefetch={false} aria-label="Sign in" className="bee">
                  <UserIcon size={20} className="text-primary-foreground" />
                </Link>
              )}
            </div>
          </div>
        </nav>
      </header>

      {/* Mobile bottom navigation — floating glass pill, 4 items */}
      {/* (Shamwari paused as a standalone destination — see FLAGS.shamwari_chat) */}
      {/* Detached from the edges (floats above the safe-area) so mobile browser */}
      {/* chrome never obscures it; stays put on scroll because it's fixed. */}
      {/* 48px min touch targets, 22px icons, 10px labels */}
      <nav
        aria-label="Mobile navigation"
        className="fixed bottom-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] left-1/2 z-40 -translate-x-1/2 rounded-full border border-text-tertiary/10 bg-surface-base/90 shadow-lg backdrop-blur-xl sm:hidden"
      >
        <div className="flex items-center gap-1 px-2 py-1.5">
          <Link
            href="/"
            className={`relative flex flex-col items-center justify-center gap-0.5 px-2 py-2 rounded-xl transition-all min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] active:scale-95 ${
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
            className={`relative flex flex-col items-center justify-center gap-0.5 px-2 py-2 rounded-xl transition-all min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] active:scale-95 ${
              isExplore ? "text-primary" : "text-text-tertiary hover:text-text-secondary"
            }`}
            aria-label="Explore locations"
            aria-current={isExplore ? "page" : undefined}
          >
            <CompassIcon size={22} />
            <span className="text-[10px] leading-tight font-medium truncate max-w-[56px]">Explore</span>
            {isExplore && <span className="absolute bottom-1 h-0.5 w-5 rounded-full bg-primary" aria-hidden="true" />}
          </Link>
          {shamwariEnabled && (
            <Link
              href="/shamwari"
              prefetch={false}
              className={`relative flex flex-col items-center justify-center gap-0.5 px-2 py-2 rounded-xl transition-all min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] active:scale-95 ${
                pathname === "/shamwari" ? "text-primary" : "text-text-tertiary hover:text-text-secondary"
              }`}
              aria-label="Shamwari AI assistant"
              aria-current={pathname === "/shamwari" ? "page" : undefined}
            >
              <SparklesIcon size={22} />
              <span className="text-[10px] leading-tight font-medium truncate max-w-[56px]">Shamwari</span>
              {pathname === "/shamwari" && <span className="absolute bottom-1 h-0.5 w-5 rounded-full bg-primary" aria-hidden="true" />}
            </Link>
          )}
          <Link
            href="/history"
            prefetch={false}
            className={`relative flex flex-col items-center justify-center gap-0.5 px-2 py-2 rounded-xl transition-all min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] active:scale-95 ${
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
            className="relative flex flex-col items-center justify-center gap-0.5 px-2 py-2 rounded-xl transition-all min-w-[var(--touch-target-min)] min-h-[var(--touch-target-min)] text-text-tertiary hover:text-text-secondary active:scale-95"
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
