import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { HomeLanding } from "./HomeLanding";
import type { WeatherLocation } from "@/lib/locations";

const BASE_URL = "https://weather.mukoko.com";
const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

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
  // Belt-and-suspenders redirect for returning users (middleware handles this too)
  const cookieStore = await cookies();
  const lastLocation = cookieStore.get("lastLocation")?.value;
  if (lastLocation && SLUG_RE.test(lastLocation)) {
    redirect(`/${lastLocation}`);
  }

  // Read Vercel's automatic IP geolocation headers
  const headersList = await headers();
  const lat = headersList.get("x-vercel-ip-latitude");
  const lon = headersList.get("x-vercel-ip-longitude");

  let detectedLocation: WeatherLocation | null = null;

  if (lat && lon) {
    try {
      // autoCreate=true: create-on-demand from the IP-derived position so a
      // first-time visitor from a city we haven't seen still lands on a real,
      // resolvable location instead of the "not found" page. Dedup in
      // upsert_placesgeo_city (5 km + normalised-name) prevents duplicates, so
      // repeat visits from the same city resolve the existing entry.
      const res = await fetch(
        `${APP_URL}/api/py/geo?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&autoCreate=true`,
        { cache: "no-store" },
      );
      if (res.ok) {
        const data = await res.json();
        if (data?.nearest) {
          detectedLocation = data.nearest as WeatherLocation;
        }
      }
    } catch {
      // Geo lookup unavailable — HomeLanding will show the city-chooser fallback
    }
  }

  return <HomeLanding detectedLocation={detectedLocation} />;
}
