import { NextRequest, NextResponse } from "next/server";
import { fetchWeather } from "@/lib/weather";

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

  try {
    const data = await fetchWeather(lat, lon);
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Failed to fetch weather data" }, { status: 502 });
  }
}
