import { Suspense } from "react";
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import {
  CurrentLocationHome,
  type HomeWeatherPayload,
} from "./CurrentLocationHome";
import {
  getLocationFromDb,
  getWeatherForLocation,
  getCountryByCode,
  getSeasonForDate,
} from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { checkFrostRisk, createFallbackWeather } from "@/lib/weather";
import type { WeatherLocation } from "@/lib/locations";
import { ipFallbackLocation } from "@/lib/home-location";
import { countryDisplayName, reconcileCountry } from "@/lib/location-country";
import { reconcileElevation } from "@/lib/location-elevation";
import { SITE_URL } from "@/lib/site";
import { fetchPlaces } from "@/lib/weather-api";
import { usableIpGeo } from "@/lib/location-choice";
import { LocationSkeleton } from "@/components/weather/LocationSkeleton";

// Bound the Worker geo fetch so a hung or protected upstream can't stall
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
    canonical: `${SITE_URL}/`,
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
export default function Home() {
  // The home page's own loading boundary. This used to be a root
  // `src/app/loading.tsx`, but a root loading boundary wraps EVERY route in
  // Suspense, so the 200 shell was flushed before any page could call
  // notFound() or send a redirect status: unknown slugs answered 200
  // "Location not found" and /profile a 200 meta-refresh (#237). Scoping the
  // boundary to `/` keeps the home loading skeleton and lets every other route
  // send its real status.
  return (
    <Suspense fallback={<LocationSkeleton />}>
      <HomeContent />
    </Suspense>
  );
}

/**
 * Longest the server render may spend resolving the seeded location and its
 * weather. Past it the page streams the client chooser (GPS / search, which
 * fetches from the Worker itself) instead of holding the first paint: an
 * installed iOS app sat on its loading screen for 30 s behind a slow
 * upstream.
 */
const HOME_SEED_DEADLINE_MS = 3_500;

const SEED_DEADLINE = Symbol("seed-deadline");

/** `work`, or SEED_DEADLINE once `ms` has passed. */
function withinDeadline<T>(
  work: Promise<T>,
  ms: number,
): Promise<T | typeof SEED_DEADLINE> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(SEED_DEADLINE), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function HomeContent() {
  const built = await withinDeadline(buildHome(), HOME_SEED_DEADLINE_MS);
  if (built !== SEED_DEADLINE) return built;
  const user = await withinDeadline(
    getCurrentUser().catch(() => null),
    500,
  );
  return (
    <CurrentLocationHome
      initial={null}
      user={
        user && user !== SEED_DEADLINE
          ? { id: user.id, email: user.email ?? null }
          : null
      }
    />
  );
}

async function buildHome() {
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
      const timeout = setTimeout(
        () => controller.abort(),
        GEO_FETCH_TIMEOUT_MS,
      );
      try {
        // autoCreate=false: IP geolocation is FIND-ONLY. Vercel's IP headers give a
        // coarse ISP/datacentre-centroid position, so creating a location from them
        // would seed inaccurate, fine-grained entries. Auto-creation only happens on
        // explicit user GPS (CurrentLocationHome's detectUserLocation flows).
        const res = await fetchPlaces(
          "geo",
          // noName: this server shares one egress address with every visitor,
          // so it never spends a geocoder lookup; the IP-city header below
          // names an IP position better anyway.
          `lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&autoCreate=false&noName=1`,
          { cache: "no-store", signal: controller.signal },
        );
        if (res.ok) {
          const data = await res.json();
          // A coordinate label is not a name for the visitor's place: the
          // IP-city fallback below names it better (`usableIpGeo`).
          if (usableIpGeo(data?.nearest)) {
            detectedLocation = data.nearest as WeatherLocation;
          }
        }
      } catch {
        // Geo lookup unavailable or timed out — the seed fallback below, then
        // the client chooser, take over.
      } finally {
        clearTimeout(timeout);
      }

      // The geo endpoint only knows placesGeo city/town/village entries, so it
      // returns nothing for regions the platform geography hasn't covered yet
      // (and for every city-state, where the only matching document is the
      // country). Falling back to the nearest location we actually ship means
      // those visitors still land on real weather instead of an empty chooser.
      if (!detectedLocation) {
        detectedLocation = ipFallbackLocation(
          Number(lat),
          Number(lon),
          headersList.get("x-vercel-ip-country"),
          headersList.get("x-vercel-ip-city"),
        );
      }
    }
  }

  const currentUser = await getCurrentUser().catch(() => null);
  const aiUser = currentUser
    ? { id: currentUser.id, email: currentUser.email ?? null }
    : null;

  // No server-side location at all — the client GPS/city-chooser takes over.
  if (!detectedLocation) {
    return <CurrentLocationHome initial={null} user={aiUser} />;
  }

  // Strip MongoDB _id (ObjectId with .toJSON()) before crossing to the client.
  const { _id: _removed, ...seededLocation } =
    detectedLocation as WeatherLocation & {
      _id?: unknown;
    };

  // Same double-caught weather fetch as the /{slug} page — the home shell
  // ALWAYS renders, worst case with seasonal estimates.
  let weather;
  let weatherSource: string;
  try {
    const result = await getWeatherForLocation(
      seededLocation.slug,
      seededLocation.lat,
      seededLocation.lon,
      seededLocation.elevation,
    );
    weather = result.data;
    weatherSource = result.source;
  } catch {
    weather = createFallbackWeather(
      seededLocation.lat,
      seededLocation.lon,
      seededLocation.elevation,
    );
    weatherSource = "fallback";
  }
  const usingFallback = weatherSource === "fallback";
  const location = reconcileElevation(
    reconcileCountry(seededLocation, weather.timezone),
    weather.elevation,
  );

  const countryCode = (location.country ?? "").toUpperCase();
  const [countryDoc, season] = await Promise.all([
    countryCode
      ? getCountryByCode(countryCode).catch(() => null)
      : Promise.resolve(null),
    getSeasonForDate(new Date(), location.country ?? "", location.lat ?? 0),
  ]);

  const initial: HomeWeatherPayload = {
    location,
    weather,
    usingFallback,
    frostAlert: usingFallback
      ? null
      : checkFrostRisk(weather.hourly, weather.utc_offset_seconds),
    season,
    countryName: countryDoc?.name ?? countryDisplayName(countryCode),
  };

  return <CurrentLocationHome initial={initial} user={aiUser} />;
}
