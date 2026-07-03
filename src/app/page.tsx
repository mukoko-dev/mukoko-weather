import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
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
 * Home page — server-side IP geo detection with instant returning-user redirect.
 *
 * Flow:
 * 1. Middleware already handles returning users (lastLocation cookie → 307 redirect).
 *    This belt-and-suspenders check handles any deployment without the edge layer.
 * 2. Reads Vercel's x-vercel-ip-latitude / x-vercel-ip-longitude headers (injected
 *    automatically on all Vercel serverless requests).
 * 3. Looks up the nearest location via /api/py/geo.
 * 4. Passes detectedLocation to HomeLanding which shows the city + 2s countdown,
 *    or a "Where are you?" chooser when detection is unavailable.
 */
export default async function Home() {
  // Belt-and-suspenders redirect for returning users (middleware handles this too).
  // Only redirect when the cookie slug both looks valid AND actually resolves to a
  // real location. A stale cookie pointing at a deleted/never-existent slug would
  // otherwise ping-pong: / → /<deadslug> → not-found → "go home" → / → … . Verifying
  // resolution first breaks that loop and lets us fall through to fresh detection.
  const cookieStore = await cookies();
  const lastLocation = cookieStore.get("lastLocation")?.value;
  if (lastLocation && SLUG_RE.test(lastLocation)) {
    const resolved = await getLocationFromDb(lastLocation).catch(() => null);
    if (resolved) {
      redirect(`/${lastLocation}`);
    }
    // Unresolvable cookie — ignore it and continue to IP-geo detection below.
  }

  // Read Vercel's automatic IP geolocation headers
  const headersList = await headers();
  const lat = headersList.get("x-vercel-ip-latitude");
  const lon = headersList.get("x-vercel-ip-longitude");

  let detectedLocation: WeatherLocation | null = null;

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

  return <HomeLanding detectedLocation={detectedLocation} />;
}
