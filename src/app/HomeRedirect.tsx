"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAppStore, hasStoreHydrated } from "@/lib/store";
import { detectUserLocation } from "@/lib/geolocation";
import { WeatherLoadingScene } from "@/components/weather/WeatherLoadingScene";
import Link from "next/link";

const HYDRATION_TIMEOUT_MS = 4000;
const SKIP_DELAY_MS = 1500;
const SAFETY_TIMEOUT_MS = 15000;
const FALLBACK_LOCATION = "harare";

/**
 * Smart home page redirect — like Apple Weather / Google Weather.
 *
 * Waits for geolocation to actually resolve (success, denied, error, or
 * outside-supported) rather than racing against a short timeout. This ensures
 * first-time users who need to interact with the browser permission prompt
 * aren't prematurely redirected to the default location.
 *
 * Escape hatches:
 * - "Choose a city instead" link appears after 1.5s
 * - 15s safety timeout as ultimate fallback if everything hangs
 *
 * Fallback chain (when geo fails):
 * 1. First saved location
 * 2. Selected location (default: harare)
 * 3. Harare
 *
 * Waits for Zustand rehydration before reading persisted state to avoid
 * acting on default values before localStorage is loaded.
 *
 * Uses router.replace() so the home page doesn't appear in browser history.
 */
export function HomeRedirect() {
  const router = useRouter();
  const hasRedirected = useRef(false);
  const [showSkip, setShowSkip] = useState(false);

  // Show a "Choose a city" fallback link after a short delay so users
  // aren't stuck staring at an unresponsive loading screen if geolocation
  // is slow or denied.
  useEffect(() => {
    const timer = setTimeout(() => setShowSkip(true), SKIP_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  // Track Zustand rehydration — hasStoreHydrated() is not reactive,
  // so we poll via rAF until hydration completes (retries on slow devices).
  // A max-wait timeout (4s) ensures we proceed with defaults if Zustand
  // persist middleware never fires (e.g., corrupt localStorage).
  const [hydrated, setHydrated] = useState(hasStoreHydrated);
  useEffect(() => {
    if (hydrated) return;
    let id: number;
    const check = () => {
      if (hasStoreHydrated()) {
        setHydrated(true);
      } else {
        id = requestAnimationFrame(check);
      }
    };
    id = requestAnimationFrame(check);
    const timeout = setTimeout(() => {
      cancelAnimationFrame(id);
      setHydrated(true);
    }, HYDRATION_TIMEOUT_MS);
    return () => {
      cancelAnimationFrame(id);
      clearTimeout(timeout);
    };
  }, [hydrated]);

  useEffect(() => {
    if (hasRedirected.current || !hydrated) return;

    let cancelled = false;

    /** Redirect to the fallback location (saved → selected → harare). */
    const redirectToFallback = () => {
      if (cancelled || hasRedirected.current) return;
      hasRedirected.current = true;
      // Read fallback at decision time so device sync (which may have
      // restored savedLocations from the server during the geo wait)
      // is reflected in the redirect target.
      const { savedLocations, selectedLocation } = useAppStore.getState();
      const fallback = savedLocations[0] || selectedLocation || FALLBACK_LOCATION;
      router.replace(`/${fallback}`);
    };

    // Safety net — if geolocation hangs completely (browser prompt left
    // open, API unreachable, etc.), redirect to fallback after 15s.
    const safetyTimer = setTimeout(redirectToFallback, SAFETY_TIMEOUT_MS);

    // Wait for geolocation to resolve naturally — no artificial timeout race.
    // The browser's getCurrentPosition has its own 10s timeout. When the user
    // denies permission or GPS fails, detectUserLocation resolves immediately
    // with an error status, so there's no unnecessary waiting.
    detectUserLocation()
      .then((result) => {
        clearTimeout(safetyTimer);
        if (cancelled || hasRedirected.current) return;
        hasRedirected.current = true;

        if (
          (result.status === "success" || result.status === "created") &&
          result.location
        ) {
          router.replace(`/${result.location.slug}`);
        } else {
          // Geo explicitly failed (denied, error, outside-supported, unavailable)
          // → redirect to fallback immediately, no waiting
          redirectToFallback();
        }
      })
      .catch(() => {
        clearTimeout(safetyTimer);
        redirectToFallback();
      });

    return () => {
      cancelled = true;
      clearTimeout(safetyTimer);
    };
  }, [router, hydrated]);

  return (
    <WeatherLoadingScene
      statusText="Finding your location..."
      action={
        showSkip ? (
          <Link
            href="/explore"
            className="animate-fade-in-up rounded-[var(--radius-button)] bg-surface-card px-5 py-3 text-base font-medium text-text-secondary shadow-md transition-colors hover:text-primary hover:bg-surface-dim min-h-[44px] inline-flex items-center"
          >
            Choose a city instead
          </Link>
        ) : null
      }
    />
  );
}
