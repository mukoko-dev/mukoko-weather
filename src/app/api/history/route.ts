import { NextRequest, NextResponse } from "next/server";
import { getWeatherHistory } from "@/lib/db";
import { getLocationBySlug } from "@/lib/locations";

/**
 * GET /api/history?location=harare&days=30
 *
 * Returns historical weather recordings for a given location.
 * Data is recorded automatically whenever the /api/weather endpoint
 * fetches fresh data from Open-Meteo.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const locationSlug = searchParams.get("location");
  const days = parseInt(searchParams.get("days") ?? "30", 10);

  if (!locationSlug) {
    return NextResponse.json({ error: "Missing location parameter" }, { status: 400 });
  }

  const location = getLocationBySlug(locationSlug);
  if (!location) {
    return NextResponse.json({ error: "Unknown location" }, { status: 404 });
  }

  if (isNaN(days) || days < 1 || days > 365) {
    return NextResponse.json({ error: "days must be between 1 and 365" }, { status: 400 });
  }

  try {
    const history = await getWeatherHistory(locationSlug, days);
    return NextResponse.json({
      location: locationSlug,
      days,
      records: history.length,
      data: history,
    });
  } catch {
    return NextResponse.json({ error: "Failed to fetch weather history" }, { status: 502 });
  }
}
