"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { WeatherLocation } from "@/lib/locations";
import type { WeatherData, FrostAlert, Season } from "@/lib/weather";
import { checkFrostRisk, getDefaultSeason } from "@/lib/weather";
import { fetchHomeWeather } from "@/lib/home-weather";
import {
  CURRENT_LOCATION_EVENT,
  writeLastLocationCookie,
} from "@/lib/current-slug";
import { detectUserLocation } from "@/lib/geolocation";
import { useAppStore } from "@/lib/store";
import { COUNTRIES } from "@/lib/countries";
import { trackEvent } from "@/lib/analytics";
import { SearchIcon, NavigationIcon } from "@/lib/weather-icons";
import { Spinner } from "@/components/ui/spinner";
import { LocationPromptCard } from "@/components/weather/LocationPromptCard";
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

type GpsState = "idle" | "detecting";

/** Set when the visitor dismisses the location card — the only thing that
 *  stops us offering it again. Never set automatically. */
const LOCATION_CARD_DISMISSED_KEY = "mukoko-location-card-dismissed";

// Fast, cache-friendly GPS read for the silent refresh (a device usually
// has a recent fix; a 5-min maximumAge makes the common case near-instant).
const GPS_TIMEOUT_MS = 4000;
const GPS_MAX_AGE_MS = 300000;
// When the nearest KNOWN place is further than this from the fix, the
// visitor's actual spot isn't in the catalog yet — create it on demand so
// "MY LOCATION" never labels a place several kilometres away.
const FAR_NEAREST_KM = 3;

function countryNameFor(code?: string): string {
  const cc = (code ?? "").toUpperCase();
  return COUNTRIES.find((c) => c.code === cc)?.name ?? cc;
}

/** Why the last attempt didn't land, in words a visitor can act on. */
type PromptMessage = "denied" | "no-location" | "no-weather" | null;

const PROMPT_COPY: Record<Exclude<PromptMessage, null>, string> = {
  denied: "Location is blocked in your browser settings.",
  "no-location": "We couldn't find where you are.",
  "no-weather": "Found you, but the weather didn't load. Try again shortly.",
};

/**
 * The home page IS the current-location weather page — Apple Weather's
 * MY LOCATION model with the URL kept silent:
 *
 * - The server seeds the dashboard with its best guess (last visited place,
 *   else IP location), so every visitor sees weather immediately. Nothing is
 *   asked before value.
 * - If the browser has ALREADY granted location, the client refreshes
 *   silently: same place → just the MY LOCATION eyebrow; different place →
 *   the dashboard swaps in place (URL stays `/`).
 * - Otherwise we never trigger the permission prompt on load. A slim
 *   LocationPromptCard offers "Use my location"; the prompt appears only
 *   when the visitor taps it, so they know why it's being asked.
 * - MY LOCATION is shown only when GPS produced the place on screen.
 * - Explicit `/{slug}` URLs remain the shareable/SEO surface for saved and
 *   browsed locations; they are untouched by this flow.
 */
export function CurrentLocationHome({ initial, user }: Props) {
  const setSelectedLocation = useAppStore((s) => s.setSelectedLocation);
  const openMyWeather = useAppStore((s) => s.openMyWeather);
  const [view, setView] = useState<HomeWeatherPayload | null>(initial);
  const [gpsState, setGpsState] = useState<GpsState>("idle");
  // True once GPS has confirmed (or produced) the location on screen — drives
  // the MY LOCATION eyebrow. Server-seeded content starts unconfirmed.
  const [gpsConfirmed, setGpsConfirmed] = useState(false);
  // The card waits for the permission check so a visitor who already granted
  // location never sees it flash before the silent refresh lands.
  const [promptReady, setPromptReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [message, setMessage] = useState<PromptMessage>(null);

  // Build the full dashboard payload for a GPS-resolved location. Weather
  // goes through our own API (same chain as the server render) — see
  // fetchHomeWeather. Throws when no weather could be loaded at all.
  async function swapTo(location: WeatherLocation, previousSlug?: string) {
    const { weather, usingFallback } = await fetchHomeWeather(
      location.lat,
      location.lon,
    );
    setView({
      location,
      weather,
      usingFallback,
      frostAlert: checkFrostRisk(weather.hourly, weather.utc_offset_seconds),
      season: getDefaultSeason(new Date(), location.lat),
      countryName: countryNameFor(location.country),
    });
    setGpsConfirmed(true);
    setSelectedLocation(location.slug);
    // Refresh the cookie so the NEXT server render seeds this location.
    writeLastLocationCookie(location.slug);
    if (previousSlug && previousSlug !== location.slug) {
      trackEvent("location_changed", {
        from: previousSlug,
        to: location.slug,
        method: "geolocation",
      });
    }
  }

  /**
   * GPS → place → weather, shared by the silent refresh and the button.
   * Returns the problem to show, or null on success.
   */
  async function locate(opts: {
    silent: boolean;
    isDisposed: () => boolean;
  }): Promise<PromptMessage> {
    const result = await detectUserLocation(
      opts.silent
        ? {
            autoCreate: false,
            timeoutMs: GPS_TIMEOUT_MS,
            maximumAgeMs: GPS_MAX_AGE_MS,
          }
        : { autoCreate: false },
    );
    if (opts.isDisposed()) return null;
    trackEvent("geolocation_result", {
      status: result.status,
      location: result.location?.slug,
    });
    if (result.status === "denied") return "denied";
    if (
      (result.status !== "success" && result.status !== "created") ||
      !result.location
    ) {
      return "no-location";
    }

    let resolved = result.location;
    const far = result.distanceKm != null && result.distanceKm > FAR_NEAREST_KM;
    if (far) {
      // The fix is fresh, so this second read comes from the browser's
      // cache — a network hop to create the real place, not another wait.
      const precise = await detectUserLocation({
        autoCreate: true,
        maximumAgeMs: GPS_MAX_AGE_MS,
      });
      if (opts.isDisposed()) return null;
      if (
        (precise.status === "success" || precise.status === "created") &&
        precise.location
      ) {
        resolved = precise.location;
      } else if (view) {
        // Couldn't pin down the exact spot: keep what's on screen rather
        // than relabel a place kilometres away as MY LOCATION.
        return "no-location";
      }
    }

    if (resolved.slug === view?.location.slug) {
      setGpsConfirmed(true);
      return null;
    }
    try {
      await swapTo(resolved, view?.location.slug);
    } catch {
      return "no-weather";
    }
    return null;
  }

  // ── Silent refresh on mount — only when location is already granted ──────
  useEffect(() => {
    if (typeof window === "undefined") return;
    let disposed = false;
    try {
      setDismissed(Boolean(localStorage.getItem(LOCATION_CARD_DISMISSED_KEY)));
    } catch {
      /* storage blocked — the card stays available */
    }

    void (async () => {
      let state: PermissionState | "unknown" = "unknown";
      try {
        const status = await navigator.permissions?.query({
          name: "geolocation",
        });
        if (status) state = status.state;
      } catch {
        // Permissions API unavailable (older Safari) — don't guess; offer the card.
      }
      if (disposed) return;
      if (state !== "granted") {
        if (state === "denied") setMessage("denied");
        setPromptReady(true);
        return;
      }
      setGpsState("detecting");
      const problem = await locate({
        silent: true,
        isDisposed: () => disposed,
      });
      if (disposed) return;
      setGpsState("idle");
      // A silent refresh that fails stays silent when weather is on screen.
      if (problem && !view) setMessage(problem);
      setPromptReady(true);
    })();

    return () => {
      disposed = true;
    };
    // Mount-only by design: `initial` is the server seed for this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The header's "My Location" button resolved a place while we're on `/`.
  useEffect(() => {
    const onLocated = (event: Event) => {
      const location = (event as CustomEvent<WeatherLocation>).detail;
      if (!location?.slug) return;
      if (location.slug === view?.location.slug) {
        setGpsConfirmed(true);
        return;
      }
      setGpsState("detecting");
      swapTo(location, view?.location.slug)
        .then(() => setMessage(null))
        .catch(() => setMessage("no-weather"))
        .finally(() => setGpsState("idle"));
    };
    window.addEventListener(CURRENT_LOCATION_EVENT, onLocated);
    return () => window.removeEventListener(CURRENT_LOCATION_EVENT, onLocated);
    // swapTo/view are read fresh on each event via the closure re-created
    // when `view` changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Explicit "Use my location" — the only path that can show the prompt.
  const handleGps = async () => {
    if (gpsState === "detecting") return;
    setGpsState("detecting");
    setMessage(null);
    try {
      setMessage(await locate({ silent: false, isDisposed: () => false }));
    } catch {
      setMessage("no-location");
    } finally {
      setGpsState("idle");
    }
  };

  const dismissCard = () => {
    setDismissed(true);
    try {
      localStorage.setItem(LOCATION_CARD_DISMISSED_KEY, "1");
    } catch {
      /* ignore */
    }
  };

  // ── Current-location dashboard (server-seeded or GPS-swapped) ────────────
  if (view) {
    const showCard = promptReady && !gpsConfirmed && !dismissed;
    return (
      <>
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
        {showCard && (
          <LocationPromptCard
            placeName={view.location.name}
            busy={gpsState === "detecting"}
            message={message ? PROMPT_COPY[message] : null}
            onUseLocation={handleGps}
            onDismiss={dismissCard}
            onSearch={() => openMyWeather()}
          />
        )}
      </>
    );
  }

  // ── Nothing to show — city chooser ────────────────────────────────────────
  return (
    <main
      id="main-content"
      className="flex min-h-[calc(100dvh-4rem)] flex-col items-center justify-center px-4 py-12"
      aria-label="Location selection"
    >
      <div className="w-full max-w-sm space-y-8 text-center">
        <section
          aria-label="Find your location"
          className="animate-fade-in space-y-6"
        >
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">
              Find your weather
            </h1>
            <p className="mt-2 text-sm text-text-secondary">
              Use your device location or search for any city worldwide.
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={handleGps}
              disabled={gpsState === "detecting"}
              aria-busy={gpsState === "detecting"}
              className="kudu press-scale"
            >
              {gpsState === "detecting" ? (
                <Spinner className="h-4 w-4 border-current border-t-transparent" />
              ) : (
                <NavigationIcon size={15} aria-hidden="true" />
              )}
              {gpsState === "detecting"
                ? "Finding your location…"
                : "Use my current location"}
            </button>
            <button
              type="button"
              onClick={() => openMyWeather()}
              className="impala press-scale"
            >
              <SearchIcon size={15} aria-hidden="true" />
              Search for a city
            </button>
            <Link
              href="/explore"
              className="dove underline-offset-4 hover:underline"
            >
              Browse all locations
            </Link>
          </div>

          {message && (
            <p className="text-sm text-severity-moderate" role="alert">
              {PROMPT_COPY[message]}
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
