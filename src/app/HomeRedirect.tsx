"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAppStore, hasStoreHydrated } from "@/lib/store";
import { detectUserLocation } from "@/lib/geolocation";
import { WeatherLoadingScene } from "@/components/weather/WeatherLoadingScene";

const GEO_TIMEOUT_MS = 3000;
const HYDRATION_TIMEOUT_MS = 4000;
const FALLBACK_LOCATION = "harare";

/**
 * Smart home page redirect — like Apple Weather / Google Weather.
 *
 * 1. Always attempt geolocation first (3s timeout)
 * 2. If geolocation succeeds → redirect to detected location
 * 3. If geolocation fails → fall back to first saved location
 * 4. If no saved locations → fall back to selected location
 * 5. Ultimate fallback → Harare
 *
 * Waits for Zustand rehydration before reading persisted state to avoid
 * acting on default values before localStorage is loaded.
 *
 * Uses router.replace() so the home page doesn't appear in browser history.
 */
export function HomeRedirect() {
  const router = useRouter();
  const hasRedirected = useRef(false);

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

    // Always attempt geolocation first — current location is the default
    let cancelled = false;

    const geoPromise = detectUserLocation();
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), GEO_TIMEOUT_MS),
    );

    Promise.race([geoPromise, timeoutPromise])
      .then((result) => {
        if (cancelled || hasRedirected.current) return;
        hasRedirected.current = true;

        if (
          result &&
          "status" in result &&
          (result.status === "success" || result.status === "created") &&
          result.location
        ) {
          router.replace(`/${result.location.slug}`);
        } else {
          // Read fallback at decision time so device sync (which may have
          // restored savedLocations from the server during the geo wait)
          // is reflected in the redirect target.
          const { savedLocations, selectedLocation } = useAppStore.getState();
          const fallback = savedLocations[0] || selectedLocation || FALLBACK_LOCATION;
          router.replace(`/${fallback}`);
        }
      })
      .catch(() => {
        if (cancelled || hasRedirected.current) return;
        hasRedirected.current = true;
        const { savedLocations, selectedLocation } = useAppStore.getState();
        const fallback = savedLocations[0] || selectedLocation || FALLBACK_LOCATION;
        router.replace(`/${fallback}`);
      });

    return () => {
      cancelled = true;
    };
  }, [router, hydrated]);

  return <WeatherLoadingScene statusText="Finding your location..." />;
}
