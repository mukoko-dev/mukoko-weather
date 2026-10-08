import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { DisplayDashboard, type DisplayLocation } from "./DisplayDashboard";
import { getLocationFromDb, getWeatherForLocation } from "@/lib/db";
import { nearestSeedLocation } from "@/lib/places";
import { LOCATIONS } from "@/lib/locations";
import { parseDisplayParams } from "@/lib/display";
import type { WeatherData } from "@/lib/weather";

const BASE_URL = "https://weather.mukoko.com";
const SLUG_RE = /^[a-z0-9-]{1,80}$/;
/** A coordinate within this distance of a shipped place borrows its name. */
const NAME_SNAP_KM = 15;
/** Shown when nothing else resolves, so the screen is never empty. */
const DEFAULT_SLUG = "harare";

export const metadata: Metadata = {
  title: "Weather Display — Live Radar, Air Quality & Forecast",
  description:
    "A full-screen live weather display for TVs, tablets and monitors: current conditions, air quality with haze advice, radar, and the forecast.",
  alternates: { canonical: `${BASE_URL}/display` },
  // A kiosk view of content that already lives at /{slug}.
  robots: { index: false, follow: true },
};

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * `/display` — the wall-display weather page. Configured entirely by URL so a
 * TV browser needs nothing but a bookmark:
 *
 *   /display?location=harare
 *   /display?lat=1.35&lon=103.82&layer=precipitationIntensity&theme=dark
 *
 * With no parameters it uses the same signals as the home page (last visited
 * place, then IP location), then falls back to Harare. No sign-in.
 */
export default async function DisplayPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = parseDisplayParams(await searchParams);
  const location = await resolveDisplayLocation(params);

  // Server-seed the forecast only for a known place: the cache is keyed by
  // slug, and a free coordinate is fetched by the client on mount instead.
  let initialWeather: WeatherData | null = null;
  if (location.slug) {
    try {
      const result = await getWeatherForLocation(
        location.slug,
        location.lat,
        location.lon,
        location.elevation,
      );
      initialWeather = result.data;
    } catch {
      // The client fetches on mount; the screen shows its loading state.
    }
  }

  return (
    <DisplayDashboard
      location={{
        slug: location.slug ?? "",
        name: location.name,
        lat: location.lat,
        lon: location.lon,
      }}
      initialWeather={initialWeather}
      layer={params.layer}
      theme={params.theme}
    />
  );
}

interface ResolvedLocation extends Omit<DisplayLocation, "slug"> {
  slug: string | null;
  elevation: number;
}

async function resolveDisplayLocation(
  params: ReturnType<typeof parseDisplayParams>,
): Promise<ResolvedLocation> {
  // 1. An explicit place.
  if (params.location) {
    const found = await getLocationFromDb(params.location).catch(() => null);
    if (found) return fromKnown(found);
  }

  // 2. An explicit coordinate. Weather is for the exact point; the name comes
  //    from a nearby shipped place when there is one.
  if (params.coords) {
    const { lat, lon } = params.coords;
    const near = nearestSeedLocation(lat, lon, NAME_SNAP_KM);
    return {
      slug: null,
      name: near?.name ?? "This location",
      lat,
      lon,
      elevation: near?.elevation ?? 0,
    };
  }

  // 3. The last place this browser visited.
  const lastLocation = (await cookies()).get("lastLocation")?.value;
  if (lastLocation && SLUG_RE.test(lastLocation)) {
    const found = await getLocationFromDb(lastLocation).catch(() => null);
    if (found) return fromKnown(found);
  }

  // 4. IP location, snapped to the nearest shipped place.
  const h = await headers();
  const ipLat = Number(h.get("x-vercel-ip-latitude"));
  const ipLon = Number(h.get("x-vercel-ip-longitude"));
  if (h.get("x-vercel-ip-latitude") && h.get("x-vercel-ip-longitude")) {
    const near = nearestSeedLocation(ipLat, ipLon);
    if (near) return fromKnown(near);
  }

  // 5. Never empty.
  const fallback =
    LOCATIONS.find((l) => l.slug === DEFAULT_SLUG) ?? LOCATIONS[0];
  return fromKnown(fallback);
}

function fromKnown(l: {
  slug: string;
  name: string;
  lat: number;
  lon: number;
  elevation: number;
}): ResolvedLocation {
  return {
    slug: l.slug,
    name: l.name,
    lat: l.lat,
    lon: l.lon,
    elevation: l.elevation,
  };
}
