"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { WeatherLocation } from "@/lib/locations";
import { detectUserLocation } from "@/lib/geolocation";
import { useAppStore } from "@/lib/store";
import { SearchIcon, NavigationIcon } from "@/lib/weather-icons";
import { WeatherLoadingScene } from "@/components/weather/WeatherLoadingScene";

interface Props {
  detectedLocation: WeatherLocation | null;
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

/**
 * Home landing — GPS-first location pipeline (mirrors Apple/Google Weather):
 *
 * 1. First visit / unresolved visitor → AUTO-trigger browser GPS on mount
 *    (`detectUserLocation({ autoCreate: true })`). Shows a "Finding your
 *    location…" scene while the browser permission prompt + lookup run.
 *      • success/created → replace to the precise GPS location.
 *      • denied / unavailable / error → gracefully fall back to the IP-detected
 *        location countdown (if any), else the city chooser. Never hangs.
 * 2. IP geo detected (server-side, no prompt): weather scene + "Taking you to
 *    [City]…" countdown — used as the fallback when GPS is unavailable.
 * 3. "Use my current location" button: explicit browser GPS (manual re-try).
 * 4. "Browse all locations": search / explore.
 *
 * Returning users are never re-prompted: a returning visitor is detected via
 * the one-time GPS_AUTOPROMPT_KEY flag or existing store state (hasOnboarded /
 * saved / selected location). The middleware/`lastLocation` cookie fast path
 * already redirects most returning users before this component ever renders.
 */
export function HomeLanding({ detectedLocation }: Props) {
  const router = useRouter();
  const [countdown, setCountdown] = useState(Math.ceil(REDIRECT_DELAY_MS / 1000));
  const [gpsState, setGpsState] = useState<GpsState>("idle");
  // `cancelled` participates in render (the Stage 2 branch below short-circuits
  // when the user has dismissed the auto-redirect), so it must be state rather
  // than a ref — react-hooks/refs forbids reading refs during render.
  const [cancelled, setCancelled] = useState(false);
  // `autoDetecting` is true while the first-visit auto-GPS attempt is in flight,
  // so we render the "Finding your location…" scene instead of the IP countdown.
  const [autoDetecting, setAutoDetecting] = useState(false);

  // ── Auto-GPS on first visit ──────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;

    // Returning-user guards — never nag on every load.
    let shouldAutoDetect = true;
    try {
      if (localStorage.getItem(GPS_AUTOPROMPT_KEY)) shouldAutoDetect = false;
    } catch {
      // Storage blocked (private mode) — skip auto-prompt rather than risk nagging.
      shouldAutoDetect = false;
    }
    // Best-effort store check (may still be hydrating; the flag above is the
    // authoritative one-time gate). A user who has onboarded or already has a
    // saved/selected location is clearly returning.
    const s = useAppStore.getState();
    if (s.hasOnboarded || s.savedLocations.length > 0 || s.selectedLocation) {
      shouldAutoDetect = false;
    }

    if (!shouldAutoDetect) return;

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
  }, [router, detectedLocation]);

  // ── IP-geo auto-redirect countdown (fallback when GPS is unavailable) ──────
  useEffect(() => {
    if (!detectedLocation || cancelled) return;

    const redirectTimer = setTimeout(() => {
      router.replace(`/${detectedLocation.slug}`);
    }, REDIRECT_DELAY_MS);

    const countdownInterval = setInterval(() => {
      setCountdown((c) => Math.max(0, c - 1));
    }, 1000);

    return () => {
      clearTimeout(redirectTimer);
      clearInterval(countdownInterval);
    };
  }, [detectedLocation, router, cancelled]);

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

  // ── Stage 2: IP geo detected — full weather scene with countdown ──
  if (detectedLocation && !cancelled) {
    return (
      <WeatherLoadingScene
        slug={detectedLocation.slug}
        statusText={`Taking you to ${detectedLocation.name}…`}
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
              {gpsState === "denied" ? "Location access denied — please search for your city." : "Could not detect location — please search for your city."}
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
