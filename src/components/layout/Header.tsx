"use client";

import { lazy, Suspense, useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { MukokoLogo } from "@/components/brand/MukokoLogo";
import { LayersIcon, UserIcon } from "@/lib/weather-icons";
import { MobileNav } from "@/components/layout/MobileNav";
import { QuickActions } from "@/components/layout/QuickActions";
import {
  showsQuickActions,
  useChromeClaimed,
} from "@/components/layout/chrome-context";
import { useAppStore } from "@/lib/store";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { initialsFor, type PublicUser } from "@/lib/user-display";
import { currentLocationSlug } from "@/lib/current-slug";
import { PHONE_QUERY, useMediaQuery } from "@/lib/use-media-query";
import {
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
  const pathname = usePathname();
  const phone = useMediaQuery(PHONE_QUERY);
  // The group is drawn with the header, except under /embed/ and on the wall
  // display (see showsQuickActions); without a group the row reserves no room.
  const quickActions = showsQuickActions(pathname ?? "");
  const [isScrolled, setIsScrolled] = useState(false);
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
        <div className="mx-auto flex max-w-[var(--chrome-max)] items-center justify-between gap-3 px-[var(--chrome-gutter)] pt-[var(--hadeda-top)] pb-[var(--chrome-pad-y)]">
          {/* Brand mark — left-aligned at every breakpoint (the parent's
              justify-between keeps the Quick actions slot on the right) */}
          <div data-header-ink className="flex min-w-0 items-center">
            {/* No viewport prefetch: "/" is a full server-rendered dashboard,
                and every page load was fetching it in the background. */}
            <Link
              href="/"
              prefetch={false}
              aria-label="mukoko weather — return to home page"
              className="flex items-center"
            >
              <MukokoLogo wordmarkClassName="hidden md:inline" />
            </Link>
          </div>

          {/* Desktop nav — plain text links, underline on active/hover */}
          <nav
            data-header-ink
            className="hidden sm:flex items-center gap-4 lg:gap-6"
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
                lives outside the Quick actions group — that group is Share,
                Notifications and Locations (plus Map and the account icon on
                desktop), and My Weather must stay reachable for anonymous
                desktop users too (mobile keeps its own separate bottom-nav
                entry, unaffected). */}
            <button
              type="button"
              onClick={() => openMyWeather()}
              className="weaver"
            >
              My Weather
            </button>
          </nav>

          {/* The Quick actions group is NOT in the header: it floats at the
              top right (below), one mount for every page. This slot is only
              the room it leaves in the row, sized from the group's own
              tokens so the brand and the nav never run under it. */}
          {quickActions && (
            <div
              aria-hidden="true"
              data-quick-actions-slot
              className="h-[var(--hadeda-height)] w-[var(--hadeda-width)] shrink-0"
            />
          )}
        </div>
      </header>

      {/* Quick actions: Share, Notifications, Locations, the same on every
          page (owner, 2026-11-11). A sibling of <header>, never inside it (a
          header with a backdrop-filter would capture the fixed group). It is
          drawn wherever a header is, and only there (the weather map, which
          has no header, draws its own): never by a second owner reading the
          path differently, so there is one group and one notifications centre.
          Desktop has no bottom bar, so Map and the account icon follow the
          three in the same pill. `auto` is clear over the sky hero at the top
          of a place page; once the header has its own surface behind the
          group (scrolled, from `sm`) the group is solid. */}
      {quickActions && (
        <QuickActions
          tone={isScrolled && !phone ? "solid" : "auto"}
          extra={
            <>
              {/* Map for the location on screen; with no real location yet,
                  send the user to Explore to pick one rather than guessing.
                  From `lg` only: the header row cannot hold five controls
                  beside the brand and the nav below 1024px (see globals.css),
                  and Map is also a card on every place page. */}
              <Link
                href={mapHref}
                prefetch={false}
                aria-label={
                  mapSlug
                    ? "Weather map"
                    : "Choose a location for the weather map"
                }
                className="bee hidden lg:flex"
              >
                <LayersIcon size={20} />
              </Link>

              {/* The account icon is for `md` up (768px and wider). On a phone
                  the avatar is the bottom bar's last slot, with the account
                  menu behind it. Sign-in/avatar routes straight to sign-in or
                  the profile page — no dropdown menu. */}
              {authedUser ? (
                <Link
                  href="/profile"
                  aria-label={`Profile${authedUser.email ? ` (${authedUser.email})` : ""}`}
                  className="bee hidden overflow-hidden md:flex"
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
                    <span className="text-sm font-medium" aria-hidden="true">
                      {initialsFor(authedUser)}
                    </span>
                  )}
                </Link>
              ) : (
                <Link
                  href="/auth/signin"
                  prefetch={false}
                  aria-label="Sign in"
                  className="bee hidden md:flex"
                >
                  <UserIcon size={20} />
                </Link>
              )}
            </>
          }
        />
      )}

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
