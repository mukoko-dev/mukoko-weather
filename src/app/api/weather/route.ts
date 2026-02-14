import { NextRequest, NextResponse } from "next/server";
import { findNearestLocation } from "@/lib/locations";
import { getWeatherForLocation } from "@/lib/db";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const lat = parseFloat(searchParams.get("lat") ?? "-17.83");
  const lon = parseFloat(searchParams.get("lon") ?? "31.05");

  if (isNaN(lat) || isNaN(lon)) {
    return NextResponse.json({ error: "Invalid coordinates" }, { status: 400 });
  }

  // Basic bounds check for Zimbabwe area
  if (lat < -23 || lat > -15 || lon < 24 || lon > 34) {
    return NextResponse.json({ error: "Coordinates outside Zimbabwe region" }, { status: 400 });
  }

  // Resolve to nearest known location for cache key
  const nearestLocation = findNearestLocation(lat, lon);
  const locationSlug = nearestLocation?.slug ?? `${lat.toFixed(2)}_${lon.toFixed(2)}`;
  const elevation = nearestLocation?.elevation ?? 1200;

  console.log("[Weather API] fetching for", locationSlug, "lat:", lat, "lon:", lon);
  const { data, source } = await getWeatherForLocation(locationSlug, lat, lon, elevation);
  console.log("[Weather API]", locationSlug, "source:", source, "temp:", data.current?.temperature_2m);

  return NextResponse.json(data, {
    headers: {
      "X-Cache": source === "cache" ? "HIT" : "MISS",
      "X-Weather-Provider": source,
    },
  });
}
