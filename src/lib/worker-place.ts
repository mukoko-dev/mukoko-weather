/**
 * A place the Worker knows that the app's own place store does not (#414).
 *
 * The Next app resolves a `/{slug}` from its stored geography and the shipped
 * seed. A community place created through the platform (`sembawang-sg`) lives
 * in the Nyuchi API's places, which only the Rust Worker reads
 * (`GET /v1/locations?slug=`, backed by `/v1/places/{slug}`), so the app's own
 * store answered "not found" for a place the Worker could name. This is that
 * lookup: render-only, nothing is stored.
 *
 * - `null`: the Worker answered and does not know the slug (404, or a body
 *   that is not that place).
 * - throws: the Worker could not answer (timeout, 5xx, network), so a caller
 *   that must tell "unknown" from "lookup failed" (the proxy's location gate)
 *   can.
 *
 * Server-side and edge safe: reads only `process.env`.
 */

import { rendersWithoutLookup, LOCATION_SLUG_RE } from "./location-gate";
import { weatherApiBase } from "./weather-api";
import type { AdaptedLocation } from "./places";

export const WORKER_PLACE_TIMEOUT_MS = 2_000;

const MIN_SLUG = 3;
const MAX_SLUG = 80;

/**
 * True for a slug worth asking the Worker about: lowercase words joined by
 * single dashes, 3 to 80 characters, not a number, not a probe path
 * (`wp-login`, `admin`...). Keeps scanners off the Worker.
 */
export function looksLikePlaceSlug(slug: string): boolean {
  if (slug.length < MIN_SLUG || slug.length > MAX_SLUG) return false;
  if (!LOCATION_SLUG_RE.test(slug)) return false;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return false;
  if (/^[0-9-]+$/.test(slug) || slug.startsWith("wp-")) return false;
  // The words that are site routes and probes, not places.
  return !PROBE_WORDS.has(slug);
}

const PROBE_WORDS: ReadonlySet<string> = new Set([
  "admin",
  "administrator",
  "api",
  "login",
  "logout",
  "config",
  "backup",
  "phpmyadmin",
  "cgi-bin",
  "robots",
  "sitemap",
  "favicon",
  "manifest",
]);

export interface WorkerPlaceOptions {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

interface WorkerLocationBody {
  location?: {
    slug?: unknown;
    name?: unknown;
    lat?: unknown;
    lon?: unknown;
    elevation?: unknown;
    province?: unknown;
    provinceSlug?: unknown;
    country?: unknown;
    tags?: unknown;
    source?: unknown;
  };
}

export async function fetchWorkerPlace(
  slug: string,
  {
    fetcher = fetch,
    timeoutMs = WORKER_PLACE_TIMEOUT_MS,
    env,
  }: WorkerPlaceOptions = {},
): Promise<AdaptedLocation | null> {
  if (rendersWithoutLookup(slug)) return null;
  const res = await fetcher(
    `${weatherApiBase(env)}/v1/locations?slug=${encodeURIComponent(slug)}`,
    {
      cache: "no-store",
      redirect: "manual",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`worker place ${res.status}`);

  const body = (await res
    .json()
    .catch(() => null)) as WorkerLocationBody | null;
  const l = body?.location;
  if (
    !l ||
    l.slug !== slug ||
    typeof l.name !== "string" ||
    !l.name ||
    typeof l.lat !== "number" ||
    typeof l.lon !== "number" ||
    !Number.isFinite(l.lat) ||
    !Number.isFinite(l.lon)
  ) {
    return null;
  }
  const source =
    l.source === "seed" || l.source === "geolocation" ? l.source : "community";
  return {
    slug,
    name: l.name,
    province: typeof l.province === "string" ? l.province : "",
    lat: l.lat,
    lon: l.lon,
    elevation:
      typeof l.elevation === "number" && Number.isFinite(l.elevation)
        ? l.elevation
        : 0,
    tags: Array.isArray(l.tags)
      ? (l.tags.filter((t) => typeof t === "string") as string[])
      : [],
    ...(typeof l.country === "string" && l.country
      ? { country: l.country }
      : {}),
    ...(typeof l.provinceSlug === "string" && l.provinceSlug
      ? { provinceSlug: l.provinceSlug }
      : {}),
    source,
    _id: `worker:${slug}`,
    updatedAt: new Date(),
  } as AdaptedLocation;
}
