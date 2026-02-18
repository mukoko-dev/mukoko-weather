import { NextRequest, NextResponse } from "next/server";
import { getApiKey } from "@/lib/db";
import { logError, logWarn } from "@/lib/observability";

/** Valid Tomorrow.io tile layer names */
const VALID_LAYERS = new Set([
  "precipitationIntensity",
  "temperature",
  "windSpeed",
  "cloudCover",
  "humidity",
]);

/** Pinned origin — all outbound requests go here and nowhere else */
const TOMORROW_TILE_ORIGIN = "https://api.tomorrow.io";

/** Timestamp must be "now" or ISO 8601 date (e.g. "2024-01-15T12:00:00Z") */
const TIMESTAMP_RE = /^(?:now|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/;

/**
 * GET /api/map-tiles — Proxy weather map tiles from Tomorrow.io.
 *
 * Keeps the API key server-side. The client requests tiles via
 * `/api/map-tiles?z={z}&x={x}&y={y}&layer={layer}` and the server
 * fetches from Tomorrow.io and streams back the PNG.
 *
 * SSRF protection:
 * - Origin is pinned to TOMORROW_TILE_ORIGIN (no user-controlled host)
 * - layer is validated against a strict whitelist
 * - z/x/y are parsed as integers and range-checked
 * - timestamp is validated against a strict regex
 * - URL is built with the URL constructor (no string interpolation)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const z = searchParams.get("z");
  const x = searchParams.get("x");
  const y = searchParams.get("y");
  const layer = searchParams.get("layer");
  const timestamp = searchParams.get("timestamp") ?? "now";

  // ── Validate parameters ──────────────────────────────────────────────────
  if (!z || !x || !y || !layer) {
    return NextResponse.json(
      { error: "Missing tile parameters" },
      { status: 400 },
    );
  }

  if (!VALID_LAYERS.has(layer)) {
    return NextResponse.json({ error: "Invalid layer" }, { status: 400 });
  }

  const zInt = parseInt(z, 10);
  const xInt = parseInt(x, 10);
  const yInt = parseInt(y, 10);

  if (isNaN(zInt) || isNaN(xInt) || isNaN(yInt)) {
    return NextResponse.json(
      { error: "Invalid tile coordinates" },
      { status: 400 },
    );
  }

  if (zInt < 1 || zInt > 12) {
    return NextResponse.json(
      { error: "Zoom out of range" },
      { status: 400 },
    );
  }

  if (!TIMESTAMP_RE.test(timestamp)) {
    return NextResponse.json(
      { error: "Invalid timestamp" },
      { status: 400 },
    );
  }

  // ── Fetch tile from Tomorrow.io ──────────────────────────────────────────
  try {
    const apiKey = await getApiKey("tomorrow");
    if (!apiKey) {
      logWarn({
        source: "weather-api",
        message: "Tomorrow.io API key not found for map tiles",
      });
      return NextResponse.json(
        { error: "Map service unavailable" },
        { status: 503 },
      );
    }

    // Build URL with constructor — pinned origin prevents SSRF.
    // All path segments are pre-validated (integers, whitelist, regex).
    const tilePath = `/v4/map/tile/${zInt}/${xInt}/${yInt}/${layer}/${timestamp}.png`;
    const tileUrl = new URL(tilePath, TOMORROW_TILE_ORIGIN);
    tileUrl.searchParams.set("apikey", apiKey);

    const tileRes = await fetch(tileUrl, {
      signal: AbortSignal.timeout(8000),
    });

    if (!tileRes.ok) {
      if (tileRes.status === 429) {
        return new NextResponse(null, {
          status: 429,
          statusText: "Rate limited",
        });
      }
      return new NextResponse(null, { status: tileRes.status });
    }

    const tileBuffer = await tileRes.arrayBuffer();

    return new NextResponse(tileBuffer, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=300, s-maxage=300",
        "X-Map-Layer": layer,
      },
    });
  } catch (err) {
    logError({
      source: "weather-api",
      severity: "medium",
      message: "Map tile proxy error",
      error: err,
      meta: { z, x, y, layer },
    });
    return new NextResponse(null, { status: 502 });
  }
}
