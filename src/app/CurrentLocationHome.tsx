"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { WeatherLocation } from "@/lib/locations";
import type { WeatherData, FrostAlert, Season } from "@/lib/weather";
import { fetchWeather, checkFrostRisk, getDefaultSeason } from "@/lib/weather";
import { detectUserLocation } from "@/lib/geolocation";
import { useAppStore } from "@/lib/store";
import { COUNTRIES } from "@/lib/countries";
import { trackEvent } from "@/lib/analytics";
import { SearchIcon, NavigationIcon } from "@/lib/weather-icons";
import { t } from "@/lib/i18n";
import { WeatherLoadingScene } from "@/components/weather/WeatherLoadingScene";
import { WeatherDashboard } from "./[location]/WeatherDashboard";
import type { AISummaryUser } from "@/components/weather/AISummary";

/**
 * Everything WeatherDashboard needs for one location — the server seeds this
 * from the lastLocation cookie / IP geo, and the client swaps it in place
 * when GPS resolves somewhere else. The page URL never changes.
 */
export interface HomeWeatherPayload {
  location: WeatherLocation;
  weather: WeatherData;
  usingFallback: boolean;
  frostAlert: FrostAlert | null;
  season: Season;
  countryName: string;
}

interface Props {
  /** Server-seeded content (cookie-resolved or IP-geo location) — null when
   *  the server had nothing to go on (true first visit, blocked cookies). */
  initial: HomeWeatherPayload | null;
  user: AISummaryUser | null;
}

type GpsState = "idle" | "detecting" | "denied" | "error";

/**
 * One-time flag: once we've auto-prompted a visitor for GPS (whatever the
 * outcome), we never auto-prompt again on future visits — unless the browser
 * reports the permission as already granted, in which case the refresh is
 * silent and free. Kept in localStorage so it's readable synchronously.
 */
const GPS_AUTOPROMPT_KEY = "mukoko-gps-autoprompted";

// Fast, cache-friendly GPS check for the silent refresh (a device usually
// has a recent fix; 5-min maximumAge makes the common case near-instant).
const GPS_TIMEOUT_MS = 4000;
const GPS_MAX_AGE_MS = 300000;
// When the find-only lookup's nearest KNOWN location is further than this
// from the GPS fix, the user's actual spot isn't in the catalog — escalate
// to create-on-demand so they see their real place.
const FAR_NEAREST_KM = 25;

function countryNameFor(code?: string): string {
  const cc = (code ?? "").toUpperCase();
  return COUNTRIES.find((c) => c.code === cc)?.name ?? cc;
}

/**
 * The home page IS the current-location weather page — Apple Weather's
 * MY LOCATION model with the URL kept silent:
 *
 * - The server seeds the dashboard with the best location it knows (the
 *   lastLocation cookie, else IP geo), so returning visitors get a full
 *   server-rendered page instantly — no countdown, no redirect, ever.
 * - On mount, the client refreshes via GPS. Same slug → nothing moves.
 *   Different slug → weather for the new spot is fetched client-side and the
 *   dashboard swaps IN PLACE (stale-while-refresh, like Apple) — the URL
 *   stays `/`. Current location takes precedence over saved by construction:
 *   there is no redirect for a saved location to win.
 * - GPS auto-runs when the browser permission is already granted (silent,
 *   free) or once ever for brand-new visitors (the one-time prompt flag).
 *   Denial/failure just leaves the seeded content — nobody gets stranded.
 * - Explicit `/{slug}` URLs remain the shareable/SEO surface for saved and
 *   browsed locations; they are untouched by this flow.
 */
export function CurrentLocationHome({ initial, user }: Props) {
  const setSelectedLocation = useAppStore((s) => s.setSelectedLocation);
  const [view, setView] = useState<HomeWeatherPayload | null>(initial);
  const [gpsState, setGpsState] = useState<GpsState>("idle");
  // True once GPS has confirmed (or produced) the location on screen — drives
  // the MY LOCATION badge. Server-seeded content starts unconfirmed.
  const [gpsConfirmed, setGpsConfirmed] = useState(false);

  // Build the full dashboard payload for a GPS-resolved location client-side.
  // Weather comes straight from the coordinate-based API; season falls back
  // to the hemisphere-aware default (the DB-driven localName is a
  // server-render nicety, not worth a round-trip here).
  async function swapTo(location: WeatherLocation, previousSlug?: string) {
    const weather = await fetchWeather(location.lat, location.lon);
    setView({
      location,
      weather,
      usingFallback: false,
      frostAlert: checkFrostRisk(weather.hourly),
      season: getDefaultSeason(new Date(), location.lat),
      countryName: countryNameFor(location.country),
    });
    setGpsConfirmed(true);
    setSelectedLocation(location.slug);
    // Refresh the cookie so the NEXT server render seeds this location —
    // same name/options the edge middleware uses on /{slug} pages.
    try {
      document.cookie = `lastLocation=${location.slug}; max-age=2592000; path=/; samesite=lax`;
    } catch {
      /* non-browser environment */
    }
    if (previousSlug && previousSlug !== location.slug) {
      trackEvent("location_changed", { from: previousSlug, to: location.slug, method: "geolocation" });
    }
  }

  // ── GPS refresh on mount — current location always has the last word ─────
  useEffect(() => {
    if (typeof window === "undefined") return;

    let disposed = false;

    void (async () => {
      // Decide whether to touch GPS at all:
      //  - permission already granted → silent refresh, always run;
      //  - never auto-prompted before → run once (may show the prompt);
      //  - previously prompted but not granted → leave the seeded content.
      let granted = false;
      try {
        const status = await navigator.permissions?.query({ name: "geolocation" });
        granted = status?.state === "granted";
        if (status?.state === "denied") return;
      } catch {
        // Permissions API unavailable — fall through to the one-time flag.
      }
      let promptedBefore = false;
      try {
        promptedBefore = Boolean(localStorage.getItem(GPS_AUTOPROMPT_KEY));
        if (!promptedBefore) localStorage.setItem(GPS_AUTOPROMPT_KEY, "1");
      } catch {
        /* ignore */
      }
      if (!granted && promptedBefore) return;
      if (disposed) return;

      // No seeded content → show the "finding you" scene while GPS runs.
      if (!initial) setGpsState("detecting");

      try {
        const result = await detectUserLocation({
          autoCreate: false,
          timeoutMs: GPS_TIMEOUT_MS,
          maximumAgeMs: GPS_MAX_AGE_MS,
        });
        if (disposed) return;
        trackEvent("geolocation_result", { status: result.status, location: result.location?.slug });

        if ((result.status === "success" || result.status === "created") && result.location) {
          let resolved = result.location;
          if (result.distanceKm != null && result.distanceKm > FAR_NEAREST_KM) {
            // Nearest catalog entry is far from the fix — create-on-demand
            // resolves the user's actual place (the browser already has a
            // fresh fix, so this is a network hop, not a second GPS wait).
            const precise = await detectUserLocation({ autoCreate: true });
            if (disposed) return;
            if ((precise.status === "success" || precise.status === "created") && precise.location) {
              resolved = precise.location;
            }
          }
          if (resolved.slug !== initial?.location.slug) {
            await swapTo(resolved, initial?.location.slug);
          } else {
            setGpsConfirmed(true);
          }
          if (!disposed) setGpsState("idle");
        } else if (!initial) {
          // Nothing seeded AND GPS failed → the chooser below takes over.
          setGpsState(result.status === "denied" ? "denied" : "error");
        } else {
          setGpsState("idle");
        }
      } catch {
        if (!disposed) setGpsState(initial ? "idle" : "error");
      }
    })();

    return () => {
      disposed = true;
    };
    // Mount-only by design: `initial` is the server seed for this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Manual "Use my current location" — explicit intent, so autoCreate directly.
  const handleGps = async () => {
    setGpsState("detecting");
    try {
      const result = await detectUserLocation({ autoCreate: true });
      trackEvent("geolocation_result", { status: result.status, location: result.location?.slug });
      if ((result.status === "success" || result.status === "created") && result.location) {
        await swapTo(result.location, view?.location.slug);
        setGpsState("idle");
      } else {
        setGpsState(result.status === "denied" ? "denied" : "error");
      }
    } catch {
      setGpsState("error");
    }
  };

  // ── Current-location dashboard (server-seeded or GPS-swapped) ────────────
  if (view) {
    return (
      <WeatherDashboard
        key={view.location.slug}
        weather={view.weather}
        location={view.location}
        usingFallback={view.usingFallback}
        frostAlert={view.frostAlert}
        season={view.season}
        countryName={view.countryName}
        user={user}
        isCurrentLocation={gpsConfirmed}
      />
    );
  }

  // ── GPS in flight with nothing seeded ─────────────────────────────────────
  if (gpsState === "detecting") {
    return <WeatherLoadingScene statusText="Finding your location…" />;
  }

  // ── Nothing to show — city chooser ────────────────────────────────────────
  return (
    <main
      id="main-content"
      className="flex min-h-[calc(100dvh-4rem)] flex-col items-center justify-center px-4 py-12"
      aria-label="Location selection"
    >
      <div className="w-full max-w-sm space-y-8 text-center">
        <section aria-label="Find your location" className="animate-fade-in space-y-6">
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">Find your weather</h1>
            <p className="mt-2 text-sm text-text-secondary">Use your device location or search for any city worldwide.</p>
          </div>

          <div className="flex flex-col gap-3">
            <button type="button" onClick={handleGps} className="kudu press-scale">
              <NavigationIcon size={15} aria-hidden="true" />
              Use my current location
            </button>
            <Link href="/explore" className="impala press-scale">
              <SearchIcon size={15} aria-hidden="true" />
              Browse all locations
            </Link>
          </div>

          {(gpsState === "denied" || gpsState === "error") && (
            <p className="text-sm text-severity-moderate" role="alert">
              {gpsState === "denied" ? t("geo.denied") : t("geo.error")}
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
