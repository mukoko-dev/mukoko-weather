import { NextRequest, NextResponse } from "next/server";
import { findNearestLocation } from "@/lib/locations";

/**
 * GET /api/geo?lat=-17.83&lon=31.05
 *
 * Given a lat/lon, return the nearest Zimbabwe location.
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

  const nearest = findNearestLocation(lat, lon);

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
}
