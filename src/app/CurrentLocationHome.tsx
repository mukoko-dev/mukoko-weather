"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { WeatherLocation } from "@/lib/locations";
import {
  CURRENT_LOCATION_EVENT,
  writeLastLocationCookie,
} from "@/lib/current-slug";
import { detectUserLocation } from "@/lib/geolocation";
import { chooseResolved, shouldCreate } from "@/lib/location-choice";
import { useAppStore } from "@/lib/store";
import {
  decideLocationAsk,
  LEGACY_LOCATION_CARD_DISMISSED_KEY,
  readBrowserPermission,
  readDeviceState,
  recordPermission,
} from "@/lib/device-state";
import { useDeviceHeartbeat } from "@/lib/use-device-heartbeat";
import { trackEvent } from "@/lib/analytics";
import { SearchIcon, NavigationIcon } from "@/lib/weather-icons";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { LocationPromptCard } from "@/components/weather/LocationPromptCard";
import { PlaceView, usePlaceStage } from "@/components/weather/PlaceStage";
import type { AISummaryUser } from "@/components/weather/AISummary";
import { seedOfPayload, type PlaceSeed } from "@/lib/place-controller";
import { resolvePlaceSeed, seedFor } from "@/lib/place-resolve";
import { recallPlace } from "@/lib/rxdb/weather-places";
import { readStorage, writeStorage } from "@/lib/safe-storage";
import {
  LAST_HOME_PLACE_KEY,
  readLastLocationFromCookieString,
} from "@/lib/last-location";

/**
 * The place `/` starts on — the server seeds this from the lastLocation
 * cookie / IP geo (a place and its season, never weather), and the client
 * swaps it in place when GPS resolves somewhere else. The page URL never
 * changes for that swap.
 */
export type HomeSeed = PlaceSeed;

// The slug last shown at `/` (kept in src/lib/last-location.ts, which the
// offline page reads too): a visit with nothing seeded by the server paints
// that place from the device (issue #269).
export { LAST_HOME_PLACE_KEY };

interface Props {
  /** Server-seeded place (cookie-resolved or IP-geo location) — null when
   *  the server had nothing to go on (true first visit, blocked cookies). */
  initial: HomeSeed | null;
  user: AISummaryUser | null;
}

type GpsState = "idle" | "detecting";

/** Set when the visitor dismisses the location card — the only thing that
 *  stops us offering it again. Never set automatically. */

// Fast, cache-friendly GPS read for the silent refresh (a device usually
// has a recent fix; a 5-min maximumAge makes the common case near-instant).
const GPS_TIMEOUT_MS = 4000;
const GPS_MAX_AGE_MS = 300000;
// When the nearest KNOWN place is further than this from the fix, the
// visitor's actual spot isn't in the catalog yet — create it on demand so
// "MY LOCATION" never labels a place several kilometres away.
const FAR_NEAREST_KM = 3;

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
  const openMyWeather = useAppStore((s) => s.openMyWeather);
  // The place stage owns what is on screen: the server's place, then the copy
  // stored on the device, then the visitor's own weather request. A GPS swap
  // and a switch to a saved place are both "show this place" on the stage.
  const stage = usePlaceStage(initial, true);
  const { controller } = stage;
  const { seed: shownSeed, view, isHome: onHomePlace } = stage.state;
  const [gpsState, setGpsState] = useState<GpsState>("idle");
  // True once GPS has confirmed (or produced) the location on screen — drives
  // the MY LOCATION eyebrow. Server-seeded content starts unconfirmed.
  const [gpsConfirmed, setGpsConfirmed] = useState(false);
  // The card waits for the permission check so a visitor who already granted
  // location never sees it flash before the silent refresh lands.
  const [promptReady, setPromptReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [message, setMessage] = useState<PromptMessage>(null);
  // Signed-in devices report themselves to the account (hourly, quietly).
  useDeviceHeartbeat(Boolean(user));

  // Remember which place `/` shows, for the next visit's device paint.
  const shownHomeSlug = onHomePlace ? view?.location.slug : undefined;
  useEffect(() => {
    if (shownHomeSlug) writeStorage(LAST_HOME_PLACE_KEY, shownHomeSlug);
  }, [shownHomeSlug]);

  // Nothing seeded by the server (cookies cleared, IP lookup failed): paint
  // the last place shown here from the device. The stage refreshes it in the
  // background and swaps the fresh forecast in.
  useEffect(() => {
    if (initial) return;
    const slug = readStorage(LAST_HOME_PLACE_KEY);
    if (!slug) return;
    let cancelled = false;
    void (async () => {
      const stored = await recallPlace(slug);
      if (cancelled || !stored) return;
      await controller.showHome(seedOfPayload(stored.payload));
    })();
    return () => {
      cancelled = true;
    };
  }, [initial, controller]);

  // A copy of this page kept by the service worker was seeded from the
  // lastLocation cookie as it was when the copy was stored. If the visitor
  // has been to other places since, the cookie is newer: show that place, as
  // a fresh server render would have. (Equal to the seed on a fresh render,
  // so this does nothing there.) Never overrides a GPS result that landed
  // first.
  useEffect(() => {
    if (!initial) return;
    const slug = readLastLocationFromCookieString(document.cookie);
    if (!slug || slug === initial.location.slug) return;
    let cancelled = false;
    void (async () => {
      const stored = await recallPlace(slug);
      const seed = stored
        ? seedOfPayload(stored.payload)
        : await resolvePlaceSeed(slug);
      if (cancelled || !seed) return;
      if (controller.homeSeed()?.location.slug !== initial.location.slug) {
        return;
      }
      await controller.showHome(seed);
    })();
    return () => {
      cancelled = true;
    };
  }, [initial, controller]);

  /** The place `/` shows right now (My Location), if the stage has one. */
  const homeSlug = () => controller.homeSeed()?.location.slug;

  // Show a GPS-resolved location as My Location. The stage paints the stored
  // copy at once and the visitor's own weather request fills the rest, so
  // this resolves when the place is on screen, not when the forecast lands.
  // `focus`: the visitor asked for it, so it also leaves another place.
  async function swapTo(
    found: WeatherLocation,
    previousSlug: string | undefined,
    focus: boolean,
  ) {
    await controller.showHome(seedFor(found), { focus });
    setGpsConfirmed(true);
    // Refresh the cookie so the NEXT server render seeds this location.
    writeLastLocationCookie(found.slug);
    if (previousSlug && previousSlug !== found.slug) {
      trackEvent("location_changed", {
        from: previousSlug,
        to: found.slug,
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

    let resolved: WeatherLocation = result.location;
    // A spot named on demand, or a stored place kilometres away, is not the
    // real place yet: create it. Never for a placeholder spot (open water,
    // or naming skipped): nothing better exists and asking again would only
    // spend the geocoder budget (`shouldCreate`).
    if (shouldCreate(result, FAR_NEAREST_KM)) {
      // The fix is fresh, so this second read comes from the browser's
      // cache — a network hop to create the real place, not another wait.
      const precise = await detectUserLocation({
        autoCreate: true,
        maximumAgeMs: GPS_MAX_AGE_MS,
      });
      if (opts.isDisposed()) return null;
      const usable =
        (precise.status === "success" || precise.status === "created") &&
        precise.location;
      if (!usable && homeSlug()) {
        // Couldn't pin down the exact spot: keep what's on screen rather
        // than relabel a place kilometres away as MY LOCATION.
        return "no-location";
      }
      // A placeholder answer never replaces a real place that was near.
      resolved = chooseResolved(result, precise);
    }

    if (resolved.slug === homeSlug()) {
      setGpsConfirmed(true);
      return null;
    }
    try {
      await swapTo(resolved, homeSlug(), !opts.silent);
    } catch {
      return "no-weather";
    }
    return null;
  }

  // ── Silent refresh on mount — only when location is already granted ──────
  useEffect(() => {
    if (typeof window === "undefined") return;
    let disposed = false;
    void (async () => {
      const browser = await readBrowserPermission("geolocation");
      if (disposed) return;
      // The old permanent "dismissed" flag becomes a "not now": it may ask
      // once more after a week, as the device-state rules say.
      try {
        if (
          localStorage.getItem(LEGACY_LOCATION_CARD_DISMISSED_KEY) &&
          !readDeviceState().geolocation
        ) {
          recordPermission("geolocation", "dismissed");
        }
        localStorage.removeItem(LEGACY_LOCATION_CARD_DISMISSED_KEY);
      } catch {
        /* storage blocked — the card follows the browser's answer alone */
      }
      if (browser === "granted") recordPermission("geolocation", "granted");
      if (browser === "denied") recordPermission("geolocation", "denied");
      const ask = decideLocationAsk({
        browser,
        stored: readDeviceState().geolocation,
      });
      if (ask !== "refresh-silently") {
        // Blocked or "not now": the card stays away, and nothing is asked.
        if (ask !== "show-prompt") setDismissed(true);
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
      if (problem && !homeSlug()) setMessage(problem);
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
      if (location.slug === homeSlug() && onHomePlace) {
        setGpsConfirmed(true);
        return;
      }
      setGpsState("detecting");
      swapTo(location, homeSlug(), true)
        .then(() => setMessage(null))
        .catch(() => setMessage("no-weather"))
        .finally(() => setGpsState("idle"));
    };
    window.addEventListener(CURRENT_LOCATION_EVENT, onLocated);
    return () => window.removeEventListener(CURRENT_LOCATION_EVENT, onLocated);
    // swapTo reads the stage fresh on each event via the closure re-created
    // when the place on screen changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownSeed, onHomePlace]);

  // Explicit "Use my location" — the only path that can show the prompt.
  const handleGps = async () => {
    if (gpsState === "detecting") return;
    setGpsState("detecting");
    setMessage(null);
    try {
      const problem = await locate({ silent: false, isDisposed: () => false });
      // Remember the answer on this device: a tap is the only thing that
      // can raise the browser prompt, and a "no" is never asked again.
      if (problem === "denied") recordPermission("geolocation", "denied");
      else if (problem === null) recordPermission("geolocation", "granted");
      setMessage(problem);
    } catch {
      setMessage("no-location");
    } finally {
      setGpsState("idle");
    }
  };

  const dismissCard = () => {
    setDismissed(true);
    // "Not now" — the browser was never asked; it may come back in a week.
    recordPermission("geolocation", "dismissed");
  };

  // ── Current-location page (server-seeded or GPS-swapped) ─────────────────
  if (shownSeed) {
    const showCard = promptReady && !gpsConfirmed && !dismissed && onHomePlace;
    return (
      <PlaceView stage={stage} user={user} isCurrentLocation={gpsConfirmed}>
        {showCard && (
          <LocationPromptCard
            placeName={shownSeed.location.name}
            busy={gpsState === "detecting"}
            message={message ? PROMPT_COPY[message] : null}
            onUseLocation={handleGps}
            onDismiss={dismissCard}
            onSearch={() => openMyWeather()}
          />
        )}
      </PlaceView>
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
            <Alert variant="warning">
              <AlertDescription className="text-sm">
                {PROMPT_COPY[message]}
              </AlertDescription>
            </Alert>
          )}
        </section>
      </div>
    </main>
  );
}
