import { NextRequest, NextResponse } from "next/server";
import { findNearestLocation } from "@/lib/locations";
import { getWeatherForLocation } from "@/lib/db";
import { createFallbackWeather } from "@/lib/weather";
import { logError, logWarn } from "@/lib/observability";

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

  try {
    const { data, source } = await getWeatherForLocation(locationSlug, lat, lon, elevation);

    if (source === "fallback") {
      logWarn({
        source: "weather-api",
        location: locationSlug,
        message: "All weather providers failed, serving seasonal estimates",
        meta: { lat, lon },
      });
    }

    return NextResponse.json(data, {
      headers: {
        "X-Cache": source === "cache" ? "HIT" : "MISS",
        "X-Weather-Provider": source,
      },
    });
  } catch (err) {
    logError({
      source: "weather-api",
      severity: "critical",
      location: locationSlug,
      message: "Unexpected error in weather API route",
      error: err,
      meta: { lat, lon },
    });

    // Even if the route itself crashes, return fallback data — never a 500
    const fallback = createFallbackWeather(lat, lon, elevation);
    return NextResponse.json(fallback, {
      headers: {
        "X-Cache": "MISS",
        "X-Weather-Provider": "fallback",
      },
    });
  }
}
