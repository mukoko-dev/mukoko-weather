"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { WeatherLocation } from "@/lib/locations";
import { detectUserLocation } from "@/lib/geolocation";
import { useAppStore } from "@/lib/store";
import { SearchIcon, NavigationIcon } from "@/lib/weather-icons";
import { t } from "@/lib/i18n";
import { WeatherLoadingScene } from "@/components/weather/WeatherLoadingScene";

interface Props {
  detectedLocation: WeatherLocation | null;
  /**
   * True when the server resolved a `lastLocation` cookie to a real
   * location — a known returning visitor, not a first-time one. Drives
   * which pipeline runs: first-time visitors get the full auto-GPS prompt;
   * returning visitors see their cached location immediately, with a silent
   * GPS recheck racing in the background (see the "silent travel recheck"
   * effect below).
   */
  isReturningUser: boolean;
}

type GpsState = "idle" | "detecting" | "denied" | "error";

const REDIRECT_DELAY_MS = 2000;

/**
 * One-time flag: once we've auto-prompted a visitor for GPS (whatever the
 * outcome), we never auto-prompt again on future visits. Kept in localStorage
 * — independent of the RxDB-backed store, so it's readable synchronously on
 * mount without waiting for hydration and survives a cleared IndexedDB.
 */
const GPS_AUTOPROMPT_KEY = "mukoko-gps-autoprompted";

// Current-location recheck for returning visitors. CURRENT LOCATION TAKES
// PRECEDENCE over the saved/cached one (the Apple Weather rule) — the
// redirect WAITS for this check to settle instead of racing it, so a
// traveling user can never be redirected to their old city just because
// GPS took a moment. A short GPS timeout + generous cache window keep the
// common case fast (a device usually has a recent fix), and the absolute
// settle cap below guarantees the redirect never hangs on a slow stack.
const SILENT_RECHECK_TIMEOUT_MS = 4000;
const SILENT_RECHECK_MAX_AGE_MS = 300000;
// Hard ceiling on how long the redirect can wait for the recheck (GPS +
// geo API round-trip). Past this, the cached location wins — never hang.
const RECHECK_SETTLE_CAP_MS = 8000;
// When the find-only recheck's nearest KNOWN location is further than this,
// the user's actual spot isn't represented in the catalog (rural travel) —
// escalate to a create-on-demand lookup so they land on their real place,
// not a far-away city that happens to be the nearest database entry.
const FAR_NEAREST_KM = 25;

/**
 * True when client-side state — independent of the server's lastLocation
 * cookie check — indicates this is a returning visitor: the one-time
 * auto-GPS-prompt flag, or existing onboarding/location state. Used as a
 * fallback signal for when cookies are blocked or were cleared but other
 * persisted state survives.
 */
function isKnownReturningVisitor(): boolean {
  try {
    if (localStorage.getItem(GPS_AUTOPROMPT_KEY)) return true;
  } catch {
    return false;
  }
  const s = useAppStore.getState();
  return Boolean(s.hasOnboarded || s.savedLocations.length > 0 || s.selectedLocation);
}

/**
 * Home landing — GPS-first location pipeline (mirrors Apple/Google Weather):
 *
 * 1. First visit / unresolved visitor → AUTO-trigger browser GPS on mount
 *    (`detectUserLocation({ autoCreate: true })`). Shows a "Finding your
 *    location…" scene while the browser permission prompt + lookup run.
 *      • success/created → replace to the precise GPS location.
 *      • denied / unavailable / error → gracefully fall back to the IP-detected
 *        location countdown (if any), else the city chooser. Never hangs.
 * 2. Returning visitor (cached lastLocation) → show that location's "Taking
 *    you to [City]…" countdown immediately, while a fast, cache-friendly GPS
 *    recheck runs. CURRENT LOCATION TAKES PRECEDENCE (the Apple Weather
 *    rule): the redirect is GATED on the recheck settling — it cannot fire
 *    while GPS is still deciding, so the cached city never wins a race. GPS
 *    resolving somewhere new swaps the redirect target (with create-on-demand
 *    escalation when the nearest known location is >25 km from the fix);
 *    denial/failure/timeout (or the 8s settle cap) lets the cached location
 *    proceed.
 * 3. IP geo detected (server-side, no prompt) with no cached location either:
 *    same countdown UI, used as the fallback for a first-time visitor whose
 *    GPS attempt failed.
 * 4. "Use my current location" button: explicit browser GPS (manual re-try).
 * 5. "Browse all locations": search / explore.
 */
export function HomeLanding({ detectedLocation, isReturningUser }: Props) {
  const router = useRouter();
  const [effectiveLocation, setEffectiveLocation] = useState(detectedLocation);
  const [countdown, setCountdown] = useState(Math.ceil(REDIRECT_DELAY_MS / 1000));
  const [gpsState, setGpsState] = useState<GpsState>("idle");
  // `cancelled` participates in render (the Stage 2 branch below short-circuits
  // when the user has dismissed the auto-redirect), so it must be state rather
  // than a ref — react-hooks/refs forbids reading refs during render.
  const [cancelled, setCancelled] = useState(false);
  // `autoDetecting` is true while the first-visit auto-GPS attempt is in flight,
  // so we render the "Finding your location…" scene instead of the IP countdown.
  const [autoDetecting, setAutoDetecting] = useState(false);
  // The redirect is GATED on the current-location recheck settling (success,
  // denial, failure, or the settle cap) — current location takes precedence
  // over the cached one, so the cached redirect must never win a race
  // against a GPS check that's still running.
  const [recheckSettled, setRecheckSettled] = useState(false);

  // ── Auto-GPS on first visit ──────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;

    // Returning-user guards — never nag on every load. isReturningUser (the
    // server-resolved lastLocation cookie) is authoritative when present;
    // isKnownReturningVisitor() catches the case where cookies are blocked or
    // were cleared but other persisted state survives.
    if (isReturningUser || isKnownReturningVisitor()) return;

    let disposed = false;

    // Defer the state flip + async work out of the effect body to satisfy the
    // lint rule against synchronous setState in effects (same pattern as
    // WeatherLoadingScene). Setting the flag here (not synchronously above)
    // also keeps React StrictMode's double-invoke from swallowing the prompt.
    const raf = requestAnimationFrame(() => {
      if (disposed) return;
      try {
        localStorage.setItem(GPS_AUTOPROMPT_KEY, "1");
      } catch {
        /* ignore */
      }
      setAutoDetecting(true);
      setCancelled(true); // suppress the IP countdown while GPS runs

      void (async () => {
        try {
          // autoCreate: create the fine-grained location from the user's GPS
          // position when none exists nearby (create-on-demand).
          const result = await detectUserLocation({ autoCreate: true });
          if (disposed) return;
          if ((result.status === "success" || result.status === "created") && result.location) {
            router.replace(`/${result.location.slug}`);
            return;
          }
          // denied / unavailable / error → graceful fallback, never hang.
          setAutoDetecting(false);
          if (detectedLocation) {
            setCancelled(false); // re-enable the IP-detected countdown fallback
          } else {
            setGpsState(result.status === "denied" ? "denied" : "error");
          }
        } catch {
          if (disposed) return;
          setAutoDetecting(false);
          if (detectedLocation) setCancelled(false);
          else setGpsState("error");
        }
      })();
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
    };
  }, [router, detectedLocation, isReturningUser]);

  // ── Current-location recheck for returning visitors ──────────────────────
  // Returning visitors skip the auto-GPS-prompt flow above and see their
  // cached location's countdown immediately — but the REDIRECT waits for
  // this check to settle (see `recheckSettled`): current location takes
  // precedence over the saved one, always. If GPS resolves somewhere new,
  // the redirect target swaps; only on denial/failure/timeout does the
  // cached location win. When the nearest KNOWN location is far from the
  // user's actual position (rural travel), a create-on-demand lookup
  // resolves their real place instead. Compares against the original cached
  // `detectedLocation` (not `effectiveLocation`) so this only ever runs once
  // per mount, never re-triggering itself after it swaps the target.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if ((!isReturningUser && !isKnownReturningVisitor()) || !detectedLocation) {
      // No recheck applies (first-time visitor, or nothing to redirect to) —
      // open the redirect gate immediately. Deferred via rAF: setState
      // synchronously in an effect body trips react-hooks/set-state-in-effect.
      const raf = requestAnimationFrame(() => setRecheckSettled(true));
      return () => cancelAnimationFrame(raf);
    }

    let disposed = false;

    // Absolute cap — whatever happens in the GPS/geo stack, the redirect
    // gate opens by RECHECK_SETTLE_CAP_MS.
    const settleCap = setTimeout(() => setRecheckSettled(true), RECHECK_SETTLE_CAP_MS);

    void (async () => {
      try {
        const result = await detectUserLocation({
          autoCreate: false,
          timeoutMs: SILENT_RECHECK_TIMEOUT_MS,
          maximumAgeMs: SILENT_RECHECK_MAX_AGE_MS,
        });
        if (disposed) return;
        if ((result.status === "success" || result.status === "created") && result.location) {
          if (result.distanceKm != null && result.distanceKm > FAR_NEAREST_KM) {
            // Nearest catalog entry is far from the actual GPS position —
            // create-on-demand resolves the user's real place (the browser
            // already has a fresh fix, so this is a network hop, not a
            // second GPS wait).
            const precise = await detectUserLocation({ autoCreate: true });
            if (disposed) return;
            if ((precise.status === "success" || precise.status === "created") && precise.location) {
              if (precise.location.slug !== detectedLocation.slug) setEffectiveLocation(precise.location);
            } else if (result.location.slug !== detectedLocation.slug) {
              setEffectiveLocation(result.location);
            }
          } else if (result.location.slug !== detectedLocation.slug) {
            setEffectiveLocation(result.location);
          }
        }
        // Denial/failure/timeout: cached location wins — nothing to swap.
      } catch {
        // Same: the cached location's countdown proceeds untouched.
      } finally {
        if (!disposed) setRecheckSettled(true);
      }
    })();

    return () => {
      disposed = true;
      clearTimeout(settleCap);
    };
  }, [isReturningUser, detectedLocation]);

  // ── Location auto-redirect countdown (cached lastLocation or IP-geo) ──────
  // For returning visitors the redirect additionally waits for the
  // current-location recheck above (`recheckSettled`) — the countdown UI
  // runs regardless, but navigation only fires once the recheck has had its
  // say. First-time/IP-geo visitors have no recheck; their gate opens in
  // the effect below.
  useEffect(() => {
    if (!effectiveLocation || cancelled || !recheckSettled) return;

    const redirectTimer = setTimeout(() => {
      router.replace(`/${effectiveLocation.slug}`);
    }, REDIRECT_DELAY_MS);

    const countdownInterval = setInterval(() => {
      setCountdown((c) => Math.max(0, c - 1));
    }, 1000);

    return () => {
      clearTimeout(redirectTimer);
      clearInterval(countdownInterval);
    };
  }, [effectiveLocation, router, cancelled, recheckSettled]);

  const handleCancel = () => { setCancelled(true); };

  const handleGps = async () => {
    setGpsState("detecting");
    setCancelled(true);
    try {
      // autoCreate: the app creates the location from the user's GPS position
      // when none exists nearby (create-on-demand). Dedup in upsert_placesgeo_city
      // (5 km + normalised-name) prevents duplicates.
      const result = await detectUserLocation({ autoCreate: true });
      if ((result.status === "success" || result.status === "created") && result.location) {
        router.replace(`/${result.location.slug}`);
      } else if (result.status === "denied") {
        setGpsState("denied");
      } else {
        setGpsState("error");
      }
    } catch {
      setGpsState("error");
    }
  };

  // ── Stage 1: GPS in flight (auto on first visit, or manual re-try) ──
  if (autoDetecting || gpsState === "detecting") {
    return (
      <WeatherLoadingScene
        statusText={autoDetecting ? "Finding your location…" : "Detecting your location…"}
      />
    );
  }

  // ── Stage 2: location detected (cached lastLocation or IP geo) — full weather scene with countdown ──
  if (effectiveLocation && !cancelled) {
    return (
      <WeatherLoadingScene
        slug={effectiveLocation.slug}
        statusText={`Taking you to ${effectiveLocation.name}…`}
        action={
          <div className="flex flex-col items-center gap-3">
            <div
              className="h-1 w-32 overflow-hidden rounded-full bg-white/20"
              role="progressbar"
              aria-label={`Redirecting in ${countdown} second${countdown !== 1 ? "s" : ""}`}
              aria-valuenow={REDIRECT_DELAY_MS - countdown * 1000}
              aria-valuemin={0}
              aria-valuemax={REDIRECT_DELAY_MS}
            >
              <div
                className="h-full rounded-full bg-white/80 transition-all"
                style={{ width: `${((REDIRECT_DELAY_MS - countdown * 1000) / REDIRECT_DELAY_MS) * 100}%`, transitionDuration: "1s" }}
              />
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={handleGps}
                className="press-scale inline-flex min-h-[var(--touch-target-min)] items-center gap-1.5 rounded-[var(--radius-button)] bg-white/15 px-4 py-2 text-sm font-medium text-white/90 backdrop-blur-sm transition-all hover:bg-white/25"
              >
                <NavigationIcon size={13} aria-hidden="true" />
                Use GPS instead
              </button>
              <Link
                href="/explore"
                onClick={handleCancel}
                className="press-scale inline-flex min-h-[var(--touch-target-min)] items-center gap-1.5 rounded-[var(--radius-button)] bg-white/15 px-4 py-2 text-sm font-medium text-white/90 backdrop-blur-sm transition-all hover:bg-white/25"
              >
                <SearchIcon size={13} aria-hidden="true" />
                Choose a city
              </Link>
            </div>
          </div>
        }
      />
    );
  }

  // ── Stage 3: No IP geo or GPS done — city chooser ──
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
            <button
              type="button"
              onClick={handleGps}
              className="kudu press-scale"
            >
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
