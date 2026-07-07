import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { CurrentLocationHome, type HomeWeatherPayload } from "./CurrentLocationHome";
import { getLocationFromDb, getWeatherForLocation, getCountryByCode, getSeasonForDate } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { checkFrostRisk, createFallbackWeather } from "@/lib/weather";
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
 * The home page IS the current-location weather page (the Apple Weather
 * MY LOCATION model) — real content, so its canonical is itself.
 */
export const metadata: Metadata = {
  title: "My Location Weather — Live Forecast & Conditions",
  description:
    "Live weather for your current location — real-time conditions, hourly and 7-day forecasts, frost alerts, and AI-powered insights from mukoko weather.",
  alternates: {
    canonical: `${BASE_URL}/`,
  },
};

export const dynamic = "force-dynamic";

/**
 * Home page — renders the CURRENT-LOCATION weather inline at `/`. The URL
 * stays silent (no slug); explicit `/{slug}` URLs remain the shareable/SEO
 * surface for saved and browsed locations.
 *
 * Server side seeds the dashboard with the best location it can know without
 * device GPS (which only exists in the browser):
 * 1. lastLocation cookie that resolves to a real location → full
 *    server-rendered dashboard for it, instantly.
 * 2. Else IP geo (Vercel's x-vercel-ip-latitude/longitude headers, find-only).
 * 3. Else nothing — the client shows the GPS/city chooser.
 *
 * CurrentLocationHome then refreshes via GPS on mount and swaps the dashboard
 * IN PLACE when the visitor is somewhere else — no redirect exists for a
 * saved location to win, so current location takes precedence by construction.
 */
export default async function Home() {
  // Only trust a cookie whose slug both looks valid AND actually resolves to
  // a real location. A stale cookie pointing at a deleted/never-existent slug
  // would otherwise strand the visitor on a broken page every time — falling
  // through to fresh detection breaks that loop.
  const cookieStore = await cookies();
  const lastLocation = cookieStore.get("lastLocation")?.value;

  let detectedLocation: WeatherLocation | null = null;

  if (lastLocation && SLUG_RE.test(lastLocation)) {
    const resolved = await getLocationFromDb(lastLocation).catch(() => null);
    if (resolved) detectedLocation = resolved;
    // Unresolvable cookie — ignore it and continue to IP-geo detection below.
  }

  // Only fall back to IP geo when there's no usable cached location — for a
  // returning visitor we already have a location to render, and the client
  // GPS refresh is the mechanism that catches travel, not IP geo.
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
        // explicit user GPS (CurrentLocationHome's detectUserLocation flows).
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
        // Geo lookup unavailable or timed out — the client chooser takes over
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  const currentUser = await getCurrentUser().catch(() => null);
  const aiUser = currentUser ? { id: currentUser.id, email: currentUser.email ?? null } : null;

  // No server-side location at all — the client GPS/city-chooser takes over.
  if (!detectedLocation) {
    return <CurrentLocationHome initial={null} user={aiUser} />;
  }

  // Strip MongoDB _id (ObjectId with .toJSON()) before crossing to the client.
  const { _id: _removed, ...location } = detectedLocation as WeatherLocation & { _id?: unknown };

  // Same double-caught weather fetch as the /{slug} page — the home shell
  // ALWAYS renders, worst case with seasonal estimates.
  let weather;
  let weatherSource: string;
  try {
    const result = await getWeatherForLocation(location.slug, location.lat, location.lon, location.elevation);
    weather = result.data;
    weatherSource = result.source;
  } catch {
    weather = createFallbackWeather(location.lat, location.lon, location.elevation);
    weatherSource = "fallback";
  }
  const usingFallback = weatherSource === "fallback";

  const countryCode = (location.country ?? "").toUpperCase();
  const [countryDoc, season] = await Promise.all([
    countryCode ? getCountryByCode(countryCode).catch(() => null) : Promise.resolve(null),
    getSeasonForDate(new Date(), location.country ?? "", location.lat ?? 0),
  ]);

  const initial: HomeWeatherPayload = {
    location,
    weather,
    usingFallback,
    frostAlert: usingFallback ? null : checkFrostRisk(weather.hourly),
    season,
    countryName: countryDoc?.name ?? countryCode,
  };

  return <CurrentLocationHome initial={initial} user={aiUser} />;
}
