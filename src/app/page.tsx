import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { HomeLanding } from "./HomeLanding";
import { getLocationFromDb } from "@/lib/db";
import type { WeatherLocation } from "@/lib/locations";

const BASE_URL = "https://weather.mukoko.com";
// Stable base for the server-to-self geo lookup. The per-deployment Vercel
// hostname env var points at a protected preview origin that 401s the self-fetch
// (Deployment Protection) — the failure is swallowed and onboarding silently
// degrades. Prefer the production hostname (like the embed route's fixed base) so
// the lookup targets a stable, publicly reachable origin; fall back to localhost
// only in development.
const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ??
  (process.env.NODE_ENV === "production" ? BASE_URL : "http://localhost:3000");

// Bound the server-to-self geo fetch so a hung or protected upstream can't stall
// the home render — the onboarding chooser is a fine fallback.
const GEO_FETCH_TIMEOUT_MS = 2500;

const SLUG_RE = /^[a-z0-9-]{1,80}$/;

/**
 * Home page canonical points to /harare so Google indexes the main location
 * page instead of the city-chooser landing.
 */
export const metadata: Metadata = {
  alternates: {
    canonical: `${BASE_URL}/harare`,
  },
};

/**
 * Home page — resolves the visitor's starting location server-side, then
 * hands off to HomeLanding for the GPS-first client pipeline.
 *
 * Flow:
 * 1. lastLocation cookie present and resolves to a real location → returning
 *    visitor. That location is passed to HomeLanding as the cached default —
 *    shown immediately, no redirect happens here. HomeLanding silently
 *    reconfirms via GPS in the background and swaps the redirect target if
 *    the visitor has travelled since their last visit (see its "silent
 *    travel recheck" effect).
 * 2. No usable cookie (first visit, cleared cookies, stale/deleted slug) →
 *    falls back to IP geo (Vercel's x-vercel-ip-latitude/longitude headers)
 *    as a rough hint while HomeLanding runs its full auto-GPS-prompt flow.
 */
export default async function Home() {
  // Only trust a cookie whose slug both looks valid AND actually resolves to
  // a real location. A stale cookie pointing at a deleted/never-existent slug
  // would otherwise strand the visitor on a "Location Unavailable" page every
  // time — falling through to fresh detection breaks that loop.
  const cookieStore = await cookies();
  const lastLocation = cookieStore.get("lastLocation")?.value;

  let detectedLocation: WeatherLocation | null = null;
  let isReturningUser = false;

  if (lastLocation && SLUG_RE.test(lastLocation)) {
    const resolved = await getLocationFromDb(lastLocation).catch(() => null);
    if (resolved) {
      detectedLocation = resolved;
      isReturningUser = true;
    }
    // Unresolvable cookie — ignore it and continue to IP-geo detection below.
  }

  // Only fall back to IP geo when there's no usable cached location — for a
  // returning visitor we already have a location to show, and HomeLanding's
  // silent GPS recheck is the mechanism that catches travel, not IP geo.
  if (!detectedLocation) {
    const headersList = await headers();
    const lat = headersList.get("x-vercel-ip-latitude");
    const lon = headersList.get("x-vercel-ip-longitude");

    if (lat && lon) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), GEO_FETCH_TIMEOUT_MS);
      try {
        // autoCreate=false: IP geolocation is FIND-ONLY. Vercel's IP headers give a
        // coarse ISP/datacentre-centroid position, so creating a location from them
        // would seed inaccurate, fine-grained entries. Auto-creation only happens on
        // explicit user GPS (HomeLanding's detectUserLocation({ autoCreate: true })).
        // Here we just resolve the nearest existing location for the countdown card.
        const res = await fetch(
          `${APP_URL}/api/py/geo?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&autoCreate=false`,
          { cache: "no-store", signal: controller.signal },
        );
        if (res.ok) {
          const data = await res.json();
          if (data?.nearest) {
            detectedLocation = data.nearest as WeatherLocation;
          }
        }
      } catch {
        // Geo lookup unavailable or timed out — HomeLanding shows the city-chooser fallback
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  return (
    <HomeLanding
      detectedLocation={detectedLocation}
      isReturningUser={isReturningUser}
    />
  );
}
