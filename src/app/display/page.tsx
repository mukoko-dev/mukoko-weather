import "@/app/globals.css";
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { DisplayDashboard, type DisplayLocation } from "./DisplayDashboard";
import { getLocationFromDb } from "@/lib/db";
import { readLastLocation } from "@/lib/last-location";
import { nearestSeedLocation, seedLocationForSlug } from "@/lib/places";
import { LOCATIONS } from "@/lib/locations";
import { parseDisplayParams } from "@/lib/display";
import { TIMED_OUT, withTimeout } from "@/lib/with-timeout";

const BASE_URL = "https://weather.mukoko.com";
/** A coordinate within this distance of a shipped place borrows its name. */
const NAME_SNAP_KM = 15;
/** Shown when nothing else resolves, so the screen is never empty. */
const DEFAULT_SLUG = "harare";
/** Longest the page waits for the stored geography to name a place. */
const PLACE_LOOKUP_TIMEOUT_MS = 2_500;

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
 *
 * The page sends the screen's frame and the place and NO weather (issue #452,
 * the rule of #414): the screen's own browser fetches the forecast on mount
 * (and every 10 minutes after), so the first byte never waits on the Worker
 * or Open-Meteo and a rate-limited server address cannot blank a wall.
 */
export default async function DisplayPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = parseDisplayParams(await searchParams);
  const location = await resolveDisplayLocation(params);

  return (
    <DisplayDashboard
      location={{
        slug: location.slug ?? "",
        name: location.name,
        lat: location.lat,
        lon: location.lon,
        country: location.country,
      }}
      layer={params.layer}
      theme={params.theme}
    />
  );
}

/**
 * A place the app ships answers from the seed (no lookup); any other slug asks
 * the stored geography, never for longer than {@link PLACE_LOOKUP_TIMEOUT_MS}
 * and never by throwing. A hung database must not hold a wall display's first
 * byte, and "advertised means renderable" for every shipped place.
 */
async function knownPlace(slug: string): Promise<KnownPlace | null> {
  const seed = seedLocationForSlug(slug);
  if (seed) return seed;
  const found = await withTimeout(
    Promise.resolve()
      .then(() => getLocationFromDb(slug))
      .catch(() => null),
    PLACE_LOOKUP_TIMEOUT_MS,
  );
  return found === TIMED_OUT ? null : found;
}

/** What the screen needs of a place the app knows. */
interface KnownPlace {
  slug: string;
  name: string;
  lat: number;
  lon: number;
  elevation: number;
  country?: string;
}

interface ResolvedLocation extends Omit<DisplayLocation, "slug" | "country"> {
  slug: string | null;
  elevation: number;
  country: string | null;
}

async function resolveDisplayLocation(
  params: ReturnType<typeof parseDisplayParams>,
): Promise<ResolvedLocation> {
  // 1. An explicit place.
  if (params.location) {
    const found = await knownPlace(params.location);
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
      // Same nearby place that lends the name, so the country can't disagree.
      country: near?.country ?? null,
    };
  }

  // 3. The last place this browser visited.
  const lastLocation = readLastLocation(await cookies());
  if (lastLocation) {
    const found = await knownPlace(lastLocation);
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

function fromKnown(l: KnownPlace): ResolvedLocation {
  return {
    slug: l.slug,
    name: l.name,
    lat: l.lat,
    lon: l.lon,
    elevation: l.elevation,
    country: l.country ?? null,
  };
}
