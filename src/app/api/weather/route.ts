import { NextRequest, NextResponse } from "next/server";
import { fetchWeather } from "@/lib/weather";
import { findNearestLocation } from "@/lib/locations";
import { getCachedWeather, setCachedWeather, recordWeatherHistory, getApiKey } from "@/lib/db";
import { fetchWeatherFromTomorrow, TomorrowRateLimitError } from "@/lib/tomorrow";

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

  try {
    // Check MongoDB cache first
    const cached = await getCachedWeather(locationSlug);
    if (cached) {
      return NextResponse.json(cached, {
        headers: { "X-Cache": "HIT" },
      });
    }

    // Cache miss — try Tomorrow.io first, fall back to Open-Meteo
    let data;
    let provider = "open-meteo";

    const tomorrowKey = await getApiKey("tomorrow").catch(() => null);
    if (tomorrowKey) {
      try {
        data = await fetchWeatherFromTomorrow(lat, lon, tomorrowKey);
        provider = "tomorrow";
      } catch (err) {
        if (err instanceof TomorrowRateLimitError) {
          console.warn("Tomorrow.io rate limit hit, falling back to Open-Meteo");
        } else {
          console.warn("Tomorrow.io fetch failed, falling back to Open-Meteo:", err);
        }
      }
    }

    if (!data) {
      data = await fetchWeather(lat, lon);
    }

    // Store in MongoDB cache (15 min TTL via TTL index) + record history
    await Promise.all([
      setCachedWeather(locationSlug, lat, lon, data),
      recordWeatherHistory(locationSlug, data),
    ]);

    return NextResponse.json(data, {
      headers: { "X-Cache": "MISS", "X-Weather-Provider": provider },
    });
  } catch {
    return NextResponse.json({ error: "Failed to fetch weather data" }, { status: 502 });
  }
}
