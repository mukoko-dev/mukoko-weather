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

/**
 * GET /api/map-tiles — Proxy weather map tiles from Tomorrow.io.
 *
 * Keeps the API key server-side. The client requests tiles via
 * `/api/map-tiles?z={z}&x={x}&y={y}&layer={layer}` and the server
 * fetches from Tomorrow.io and streams back the PNG.
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

    const tileUrl = `https://api.tomorrow.io/v4/map/tile/${zInt}/${xInt}/${yInt}/${layer}/${timestamp}.png?apikey=${apiKey}`;

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
