"use client";

import { lazy, Suspense, useState, useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { Ellipsis, List as ListIcon, Map as MapIcon } from "lucide-react";
import { MukokoLogo } from "@/components/brand/MukokoLogo";
import { LayersIcon, BellIcon, UserIcon } from "@/lib/weather-icons";
import { Spinner } from "@/components/ui/spinner";
import { LocationPager } from "@/components/layout/LocationPager";
import { useAppStore } from "@/lib/store";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { trackEvent } from "@/lib/analytics";
import { initialsFor, type PublicUser } from "@/lib/user-display";
import {
  currentLocationSlug,
  isLocationSlug,
  CURRENT_LOCATION_EVENT,
  writeLastLocationCookie,
} from "@/lib/current-slug";

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

/** 48px round glass button for the bottom bar's left and right parts. */
const ROUND_BUTTON_CLASS =
  "flex h-[var(--touch-target-min)] w-[var(--touch-target-min)] shrink-0 items-center justify-center rounded-full border border-text-tertiary/10 bg-surface-card text-text-primary shadow-sm transition-transform active:scale-95";

/** One row of the mobile ⋯ menu — full 48px touch height. */
const MENU_ITEM_CLASS =
  "flex min-h-[var(--touch-target-min)] w-full items-center gap-2 rounded-lg px-3 text-left text-base font-medium text-text-primary transition-colors hover:bg-surface-dim aria-[current=page]:text-primary";

export function Header() {
  const openMyWeather = useAppStore((s) => s.openMyWeather);
  const myWeatherOpen = useAppStore((s) => s.myWeatherOpen);
  const selectedLocation = useAppStore((s) => s.selectedLocation);
  const savedLocations = useAppStore((s) => s.savedLocations);
  const setSelectedLocation = useAppStore((s) => s.setSelectedLocation);
  const reportModalOpen = useAppStore((s) => s.reportModalOpen);
  const pathname = usePathname();
  const router = useRouter();
  const [isScrolled, setIsScrolled] = useState(false);
  const [locating, setLocating] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const notificationsRef = useRef<HTMLDivElement>(null);
  const bellButtonRef = useRef<HTMLButtonElement>(null);
  // Mobile "⋯" menu — the destinations that used to sit in the bottom bar.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
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
      if (
        notificationsRef.current &&
        !notificationsRef.current.contains(e.target as Node)
      ) {
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

  // Dismiss the mobile ⋯ menu on outside click or Escape (Escape returns focus
  // to its trigger). Items close the menu themselves when activated.
  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeydown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeydown);
    };
  }, [menuOpen]);

  // Center mobile-nav action: find where the user is right now (same GPS →
  // /api/py/geo flow as My Weather's "Use current location" button, autoCreate
  // included), select it, and land on the home page — the home page IS the
  // current-location view and refreshes GPS in place, so no slug URL is needed.
  // On denial or failure the My Weather modal opens instead — its Location tab
  // has search plus a geolocation retry with proper error copy.
  const handleMyLocation = async () => {
    if (locating) return;
    setLocating(true);
    try {
      // Deferred import — keeps geolocation out of the initial header bundle
      // (same reasoning as the lazy MyWeatherModal above).
      const { detectUserLocation } = await import("@/lib/geolocation");
      const result = await detectUserLocation({ autoCreate: true });
      trackEvent("geolocation_result", {
        status: result.status,
        location: result.location?.slug,
      });
      if (
        (result.status === "success" || result.status === "created") &&
        result.location &&
        isLocationSlug(result.location.slug)
      ) {
        trackEvent("location_changed", {
          from: currentLocationSlug(pathname, selectedLocation) ?? "",
          to: result.location.slug,
          method: "geolocation",
        });
        setSelectedLocation(result.location.slug);
        // Seed the next server render of `/` with this place, then go home —
        // or, already there, hand the place to CurrentLocationHome directly.
        writeLastLocationCookie(result.location.slug);
        if (pathname === "/") {
          window.dispatchEvent(
            new CustomEvent(CURRENT_LOCATION_EVENT, {
              detail: result.location,
            }),
          );
        } else {
          router.push("/");
        }
      } else {
        openMyWeather();
      }
    } finally {
      setLocating(false);
    }
  };

  // Active page flags for the desktop nav and the mobile ⋯ menu.
  const isExplore = pathname === "/explore" || pathname.startsWith("/explore/");
  const isHistory = pathname === "/history";
  const isAviation = pathname === "/aviation";
  const isLocationList = pathname === "/locations";
  const shamwariEnabled = isFeatureEnabled("shamwari_chat");
  const mapSlug = currentLocationSlug(pathname, selectedLocation);
  const mapHref = mapSlug ? `/${mapSlug}/map` : "/explore";

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
        <nav
          aria-label="Primary navigation"
          className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6 md:px-8"
        >
          {/* Brand mark — left-aligned at every breakpoint (the parent nav's
              justify-between keeps the action pill on the right) */}
          <div className="flex min-w-0 items-center">
            <Link
              href="/"
              aria-label="mukoko weather — return to home page"
              className="flex items-center"
            >
              <MukokoLogo />
            </Link>
          </div>

          {/* Desktop nav — plain text links, underline on active/hover */}
          <nav
            className="hidden sm:flex items-center gap-6"
            aria-label="Main navigation"
          >
            {[
              { href: "/explore", label: "Explore", active: isExplore },
              // Paused as a standalone destination — see FLAGS.shamwari_chat.
              ...(shamwariEnabled
                ? [
                    {
                      href: "/shamwari",
                      label: "Shamwari",
                      active: pathname === "/shamwari",
                    },
                  ]
                : []),
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

              {/* Mobile only — Explore, History, Aviation, My Weather and the
                  GPS action live here now that the bottom bar is map / pages /
                  list. Desktop keeps its text nav instead. */}
              <div className="relative sm:hidden" ref={menuRef}>
                <button
                  ref={menuButtonRef}
                  onClick={() => setMenuOpen((v) => !v)}
                  aria-label="More options"
                  aria-expanded={menuOpen}
                  aria-controls="mobile-more-menu"
                  className="bee"
                  type="button"
                >
                  <Ellipsis
                    size={20}
                    className="text-primary-foreground"
                    aria-hidden="true"
                  />
                </button>
                {menuOpen && (
                  <div
                    id="mobile-more-menu"
                    className="absolute right-0 top-full z-40 mt-2 w-56 rounded-[var(--radius-card)] border border-text-tertiary/10 bg-surface-card p-2 shadow-lg"
                  >
                    <ul className="flex flex-col">
                      <li>
                        <Link
                          href="/explore"
                          prefetch={false}
                          aria-current={isExplore ? "page" : undefined}
                          onClick={() => setMenuOpen(false)}
                          className={MENU_ITEM_CLASS}
                        >
                          Explore
                        </Link>
                      </li>
                      {shamwariEnabled && (
                        <li>
                          <Link
                            href="/shamwari"
                            prefetch={false}
                            aria-current={
                              pathname === "/shamwari" ? "page" : undefined
                            }
                            onClick={() => setMenuOpen(false)}
                            className={MENU_ITEM_CLASS}
                          >
                            Shamwari
                          </Link>
                        </li>
                      )}
                      <li>
                        <Link
                          href="/history"
                          prefetch={false}
                          aria-current={isHistory ? "page" : undefined}
                          onClick={() => setMenuOpen(false)}
                          className={MENU_ITEM_CLASS}
                        >
                          History
                        </Link>
                      </li>
                      <li>
                        <Link
                          href="/aviation"
                          prefetch={false}
                          aria-current={isAviation ? "page" : undefined}
                          onClick={() => setMenuOpen(false)}
                          className={MENU_ITEM_CLASS}
                        >
                          Aviation
                        </Link>
                      </li>
                      <li>
                        <button
                          type="button"
                          onClick={() => {
                            setMenuOpen(false);
                            openMyWeather();
                          }}
                          className={MENU_ITEM_CLASS}
                        >
                          My Weather
                        </button>
                      </li>
                      <li>
                        <button
                          type="button"
                          onClick={() => {
                            setMenuOpen(false);
                            void handleMyLocation();
                          }}
                          disabled={locating}
                          aria-busy={locating}
                          className={MENU_ITEM_CLASS}
                        >
                          {locating && <Spinner className="h-4 w-4" />}
                          Use my location
                        </button>
                      </li>
                    </ul>
                  </div>
                )}
              </div>

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
                    <span
                      className="text-xs font-medium text-primary-foreground"
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
                  className="bee"
                >
                  <UserIcon size={20} className="text-primary-foreground" />
                </Link>
              )}
            </div>
          </div>
        </nav>
      </header>

      {/* Mobile bottom bar — iOS Weather style: a translucent full-width bar,
          safe-area aware, with three parts. Left: the map for the location on
          screen. Centre: the page indicator (My Location glyph + one dot per
          saved location). Right: the location list. */}
      <nav
        aria-label="Mobile navigation"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-text-tertiary/10 bg-surface-base/80 px-4 pt-2.5 pb-[calc(env(safe-area-inset-bottom,0px)+0.625rem)] shadow-lg backdrop-blur-xl sm:hidden"
      >
        <div className="flex items-center gap-3">
          <Link
            href={mapHref}
            prefetch={false}
            aria-label={
              mapSlug ? "Weather map" : "Choose a location for the weather map"
            }
            className={ROUND_BUTTON_CLASS}
          >
            <MapIcon size={22} aria-hidden="true" />
          </Link>
          <LocationPager
            pathname={pathname}
            savedLocations={savedLocations}
            selectedLocation={selectedLocation}
          />
          <Link
            href="/locations"
            prefetch={false}
            aria-label="All locations"
            aria-current={isLocationList ? "page" : undefined}
            className={`${ROUND_BUTTON_CLASS} ${isLocationList ? "text-primary" : ""}`}
          >
            <ListIcon size={22} aria-hidden="true" />
          </Link>
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
