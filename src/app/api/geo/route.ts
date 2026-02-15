import { NextRequest, NextResponse } from "next/server";
import { findNearestLocationsFromDb } from "@/lib/db";
import { logError } from "@/lib/observability";

/**
 * GET /api/geo?lat=-17.83&lon=31.05
 *
 * Given a lat/lon, return the nearest Zimbabwe location from MongoDB.
 * Used by the client after detecting geolocation to resolve
 * the nearest weather station.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const lat = parseFloat(searchParams.get("lat") ?? "");
  const lon = parseFloat(searchParams.get("lon") ?? "");

  if (isNaN(lat) || isNaN(lon)) {
    return NextResponse.json({ error: "Missing or invalid lat/lon" }, { status: 400 });
  }

  try {
    const results = await findNearestLocationsFromDb(lat, lon, { limit: 1 });
    const nearest = results[0] ?? null;

    if (!nearest) {
      return NextResponse.json(
        { error: "Location appears to be outside Zimbabwe", nearest: null },
        { status: 404 },
      );
    }

    return NextResponse.json({
      nearest,
      redirectTo: `/${nearest.slug}`,
    });
  } catch (err) {
    logError({
      source: "mongodb",
      severity: "high",
      message: "Geo API query failed",
      error: err,
      meta: { lat, lon },
    });
    return NextResponse.json(
      { error: "Location service unavailable" },
      { status: 503 },
    );
  }
}
