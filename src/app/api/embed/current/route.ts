/**
 * Public embed API — current weather for the visitor's location.
 *
 * GET /api/embed/current
 *   ?lat=<n>&lon=<n>   — explicit coordinates (highest priority)
 *   ?slug=<location>   — a known location slug
 *   (none)             — derive location from the request IP via Vercel's
 *                        `x-vercel-ip-latitude` / `x-vercel-ip-longitude` headers
 *
 * This route is a thin public shaper: it reads IP-geo headers, calls the
 * EXISTING internal `/api/py/geo` (name lookup) and `/api/py/weather`
 * (weather by lat/lon) endpoints, and returns a compact embed-friendly JSON
 * payload (current conditions + up to 7 daily entries for the forecast cards).
 *
 * It is a PUBLIC embed endpoint: permissive CORS, resilient fallbacks, and
 * cache-control tuned so IP-derived responses are never shared-cached.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  DEFAULT_SITE,
  shapeEmbedResponse,
  type EmbedSource,
  type LocationMeta,
  type WeatherResponse,
} from "./shape";

export const runtime = "edge";

// Harare — used as a last-resort default when no location can be derived.
const DEFAULT_LAT = -17.83;
const DEFAULT_LON = 31.05;

// Trusted base URL for internal API calls. A FIXED value — never derived from
// the incoming request (`req.url`/Host is attacker-controllable, which would
// make the internal fetches an SSRF sink). In production this is the canonical
// public domain (reachable from the Edge runtime; VERCEL_URL is a per-deploy
// host that isn't reliably reachable here). Falls back to localhost in dev.
const INTERNAL_BASE =
  process.env.NEXT_PUBLIC_APP_URL ??
  (process.env.NODE_ENV === "production"
    ? "https://weather.mukoko.com"
    : "http://localhost:3000");

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function parseCoord(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(req: NextRequest): Promise<Response> {
  const params = req.nextUrl.searchParams;

  const qsLat = parseCoord(params.get("lat"));
  const qsLon = parseCoord(params.get("lon"));
  const slug = (params.get("slug") || "").trim().toLowerCase();

  let lat: number;
  let lon: number;
  let source: EmbedSource;
  let meta: LocationMeta | null = null;

  if (qsLat !== null && qsLon !== null) {
    // 1. Explicit coordinates win.
    lat = qsLat;
    lon = qsLon;
    source = "coords";
  } else if (slug && /^[a-z0-9-]{1,80}$/.test(slug)) {
    // 2. Known location slug — resolve to coordinates via internal locations API.
    const loc = await fetchJson<Record<string, unknown> | Record<string, unknown>[]>(
      `${INTERNAL_BASE}/api/py/locations?slug=${encodeURIComponent(slug)}`,
    );
    const doc = Array.isArray(loc) ? loc[0] : loc;
    const dLat = doc ? Number(doc.lat) : NaN;
    const dLon = doc ? Number(doc.lon) : NaN;
    if (doc && Number.isFinite(dLat) && Number.isFinite(dLon)) {
      lat = dLat;
      lon = dLon;
      meta = {
        name: String(doc.name ?? slug),
        province: String(doc.province ?? ""),
        slug: String(doc.slug ?? slug),
        country: String(doc.country ?? ""),
        lat,
        lon,
      };
    } else {
      lat = DEFAULT_LAT;
      lon = DEFAULT_LON;
    }
    source = "slug";
  } else {
    // 3. Derive location from the request IP (Vercel injects these headers).
    const ipLat = parseCoord(req.headers.get("x-vercel-ip-latitude"));
    const ipLon = parseCoord(req.headers.get("x-vercel-ip-longitude"));
    if (ipLat !== null && ipLon !== null) {
      lat = ipLat;
      lon = ipLon;
      source = "ip";
    } else {
      lat = DEFAULT_LAT;
      lon = DEFAULT_LON;
      source = "fallback";
    }
  }

  // Fetch weather (resilient — the internal route never fails, but guard anyway).
  const weather = await fetchJson<WeatherResponse>(
    `${INTERNAL_BASE}/api/py/weather?lat=${lat}&lon=${lon}`,
  );

  // Resolve a display name if we don't already have one (coords / ip paths).
  if (!meta) {
    const geo = await fetchJson<{ nearest?: Record<string, unknown> }>(
      `${INTERNAL_BASE}/api/py/geo?lat=${lat}&lon=${lon}`,
    );
    const near = geo?.nearest;
    meta = {
      name: near ? String(near.name ?? "Your location") : "Your location",
      province: near ? String(near.province ?? "") : "",
      slug: near ? String(near.slug ?? "") : "",
      country: near ? String(near.country ?? "") : "",
      lat,
      lon,
    };
  }

  const body = shapeEmbedResponse(weather, meta, source, DEFAULT_SITE);

  // IP-derived responses vary per visitor → must not be shared-cached.
  const cacheControl =
    source === "ip" || source === "fallback"
      ? "private, max-age=300"
      : "public, max-age=300, s-maxage=600, stale-while-revalidate=1800";

  return NextResponse.json(body, {
    headers: { ...CORS_HEADERS, "Cache-Control": cacheControl },
  });
}
