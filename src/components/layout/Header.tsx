"use client";

import { lazy, Suspense, useState, useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { MukokoLogo } from "@/components/brand/MukokoLogo";
import { LayersIcon, BellIcon, UserIcon } from "@/lib/weather-icons";
import { LocationsLink } from "@/components/layout/LocationsLink";
import { NotificationsBoundary } from "@/components/notifications/NotificationsBoundary";
import { MobileNav } from "@/components/layout/MobileNav";
import { useChromeClaimed } from "@/components/layout/chrome-context";
import { useAppStore } from "@/lib/store";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { initialsFor, type PublicUser } from "@/lib/user-display";
import { currentLocationSlug } from "@/lib/current-slug";
import { useAlertBadge } from "@/lib/use-alerts";
import {
  NOTIFICATIONS_LABEL,
  isDestinationActive,
  visibleHeaderDestinations,
  weatherMapHref,
} from "@/lib/header-nav";

// Code-split: MyWeatherModal imports LOCATIONS (154 items), ACTIVITIES (20 items),
// geolocation, router, etc. Lazy-loading prevents this from bloating the initial
// JS bundle, which is critical for iOS PWA memory limits.
const MyWeatherModal = lazy(() =>
  import("@/components/weather/MyWeatherModal").then((m) => ({
    default: m.MyWeatherModal,
  })),
);

// The notifications centre (the alerts list and its settings) loads when it
// is first opened, so none of it is in a page's first-load JavaScript.
const NotificationsCentre = lazy(() =>
  import("@/components/notifications/NotificationsCentre").then((m) => ({
    default: m.NotificationsCentre,
  })),
);

const WeatherReportModal = lazy(() =>
  import("@/components/weather/reports/WeatherReportModal").then((m) => ({
    default: m.WeatherReportModal,
  })),
);

/**
 * The page-level header. The root layout owns the real one (`SiteHeader`, via
 * `AppChrome`), so this renders nothing while that is mounted.
 */
export function Header() {
  return useChromeClaimed() ? null : <SiteHeader />;
}

export function SiteHeader() {
  const openMyWeather = useAppStore((s) => s.openMyWeather);
  const myWeatherOpen = useAppStore((s) => s.myWeatherOpen);
  const selectedLocation = useAppStore((s) => s.selectedLocation);
  const savedLocations = useAppStore((s) => s.savedLocations);
  const reportModalOpen = useAppStore((s) => s.reportModalOpen);
  const notificationsOpen = useAppStore((s) => s.notificationsOpen);
  const openNotifications = useAppStore((s) => s.openNotifications);
  const closeNotifications = useAppStore((s) => s.closeNotifications);
  const alertCount = useAlertBadge();
  const pathname = usePathname();
  const [isScrolled, setIsScrolled] = useState(false);
  // The bell's wrapper: the centre's popover hangs under it.
  const notificationsRef = useRef<HTMLDivElement>(null);
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

  // Active page flags for the desktop nav and the mobile ⋯ menu.
  // The header's destinations come from one list shared with the phone menu
  // (src/lib/header-nav.ts, built on lib/nav-destinations), so the two can
  // never drift. Shamwari is paused: omitted while FLAGS.shamwari_chat is off.
  const destinations = visibleHeaderDestinations(isFeatureEnabled);
  const mapSlug = currentLocationSlug(pathname, selectedLocation);
  const mapHref = weatherMapHref(mapSlug);

  return (
    <>
      <header
        data-site-header
        data-scrolled={isScrolled ? "" : undefined}
        className={`sticky top-0 z-30 border-b transition-all duration-300 ${
          isScrolled
            ? "bg-surface-base/70 backdrop-blur-xl border-text-tertiary/10 shadow-sm"
            : "border-transparent"
        }`}
        role="banner"
      >
        {/* A plain wrapper, not a nav: the desktop links below are the one
            navigation landmark in the header. A nav around a nav is nested
            landmarks, which screen readers announce twice. */}
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6 md:px-8">
          {/* Brand mark — left-aligned at every breakpoint (the parent nav's
              justify-between keeps the action pill on the right) */}
          <div data-header-ink className="flex min-w-0 items-center">
            {/* No viewport prefetch: "/" is a full server-rendered dashboard,
                and every page load was fetching it in the background. */}
            <Link
              href="/"
              prefetch={false}
              aria-label="mukoko weather — return to home page"
              className="flex items-center"
            >
              <MukokoLogo />
            </Link>
          </div>

          {/* Desktop nav — plain text links, underline on active/hover */}
          <nav
            data-header-ink
            className="hidden sm:flex items-center gap-6"
            aria-label="Main navigation"
          >
            {destinations.map(({ href, label }) => {
              const active = isDestinationActive(pathname, href);
              return (
                <Link
                  key={href}
                  href={href}
                  prefetch={false}
                  aria-current={active ? "page" : undefined}
                  className={active ? "weaver-active" : "weaver"}
                >
                  {label}
                </Link>
              );
            })}
            {/* My Weather opens a modal (not a route), so it's a button rather
                than a Link, but styled identically to the other nav items. It
                lives outside the icon group below — that group is reserved
                for map / notifications / account, and My Weather must stay
                reachable for anonymous desktop users too (mobile keeps its
                own separate bottom-nav entry, unaffected). */}
            <button
              type="button"
              onClick={() => openMyWeather()}
              className="weaver"
            >
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
              {/* Map for the location on screen; with no real location yet,
                  send the user to Explore to pick one rather than guessing. */}
              <Link
                href={mapHref}
                prefetch={false}
                aria-label={
                  mapSlug
                    ? "Weather map"
                    : "Choose a location for the weather map"
                }
                className="bee hidden sm:flex"
              >
                <LayersIcon size={20} className="text-primary-foreground" />
              </Link>

              {/* Mobile only — Locations, the round list link to
                  `/locations` (owner, 2026-11-11: the Locations icon moves to
                  the top right of the screen). On a place page it is in the
                  hero's top group instead (the phone header is not drawn
                  there), so it is reachable on every phone page. The account
                  avatar is the last slot of the bottom bar. Desktop keeps its
                  text nav and has no Locations icon. */}
              <LocationsLink
                className="bee sm:hidden"
                iconClassName="text-primary-foreground"
              />

              <div className="relative" ref={notificationsRef}>
                {/* The bell opens the notifications centre (alerts for your
                    places and their settings). The dot says there is
                    something to read; the count is in the name. */}
                <button
                  onClick={() =>
                    notificationsOpen
                      ? closeNotifications()
                      : openNotifications("list")
                  }
                  data-notifications-trigger
                  aria-label={
                    alertCount > 0
                      ? `${NOTIFICATIONS_LABEL}, ${alertCount} ${alertCount === 1 ? "alert" : "alerts"}`
                      : NOTIFICATIONS_LABEL
                  }
                  aria-haspopup="dialog"
                  aria-expanded={notificationsOpen}
                  className="bee relative"
                  type="button"
                >
                  <BellIcon size={20} className="text-primary-foreground" />
                  {alertCount > 0 && (
                    <span
                      aria-hidden="true"
                      data-alert-dot
                      className="absolute right-3 top-3 h-2.5 w-2.5 rounded-full bg-primary-foreground ring-2 ring-primary"
                    />
                  )}
                </button>
                {notificationsOpen && (
                  <NotificationsBoundary onClose={closeNotifications}>
                    <Suspense>
                      <NotificationsCentre anchorRef={notificationsRef} />
                    </Suspense>
                  </NotificationsBoundary>
                )}
              </div>

              {/* The account icon is desktop's (`sm` up). On a phone the
                  avatar is the bottom bar's first slot, with the account
                  menu behind it. */}
              {authedUser ? (
                <Link
                  href="/profile"
                  aria-label={`Profile${authedUser.email ? ` (${authedUser.email})` : ""}`}
                  className="bee hidden overflow-hidden sm:flex"
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
                    <span
                      className="text-sm font-medium text-primary-foreground"
                      aria-hidden="true"
                    >
                      {initialsFor(authedUser)}
                    </span>
                  )}
                </Link>
              ) : (
                <Link
                  href="/auth/signin"
                  prefetch={false}
                  aria-label="Sign in"
                  className="bee hidden sm:flex"
                >
                  <UserIcon size={20} className="text-primary-foreground" />
                </Link>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Mobile navigation — the floating island (see MobileNav). */}
      <MobileNav
        pathname={pathname}
        savedLocations={savedLocations}
        selectedLocation={selectedLocation}
        mapHref={mapHref}
        hasMapLocation={Boolean(mapSlug)}
      />

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
