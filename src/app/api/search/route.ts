import { NextRequest, NextResponse } from "next/server";
import {
  searchLocationsFromDb,
  findNearestLocationsFromDb,
  getTagCounts,
} from "@/lib/db";
import { logError } from "@/lib/observability";

/**
 * GET /api/search?q=<query>&tag=<tag>&lat=<lat>&lon=<lon>&limit=<n>&skip=<n>
 *
 * Search locations using MongoDB text search + geospatial queries.
 * Falls back to in-memory search if MongoDB is unavailable.
 *
 * Query params:
 *   q     - text search query (fuzzy, searches name, province, slug)
 *   tag   - filter by location tag (city, farming, mining, tourism, etc.)
 *   lat   - latitude for nearest-location search (requires lon)
 *   lon   - longitude for nearest-location search (requires lat)
 *   limit - max results (default 20, max 50)
 *   skip  - pagination offset (default 0)
 *   mode  - "tags" to return tag counts instead of locations
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const q = searchParams.get("q") ?? "";
  const tag = searchParams.get("tag") ?? undefined;
  const lat = searchParams.get("lat");
  const lon = searchParams.get("lon");
  const mode = searchParams.get("mode");
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "20", 10) || 20, 50);
  const skip = parseInt(searchParams.get("skip") ?? "0", 10) || 0;

  // Mode: return tag counts
  if (mode === "tags") {
    try {
      const tags = await getTagCounts();
      return NextResponse.json({ tags });
    } catch (err) {
      logError({
        source: "mongodb",
        severity: "medium",
        message: "Tag counts query failed",
        error: err,
      });
      return NextResponse.json({ error: "Search unavailable" }, { status: 503 });
    }
  }

  // Mode: geospatial nearest search
  if (lat && lon) {
    const latNum = parseFloat(lat);
    const lonNum = parseFloat(lon);
    if (isNaN(latNum) || isNaN(lonNum)) {
      return NextResponse.json({ error: "Invalid lat/lon" }, { status: 400 });
    }

    try {
      const locations = await findNearestLocationsFromDb(latNum, lonNum, { limit });
      return NextResponse.json({ locations, total: locations.length, source: "mongodb" });
    } catch (err) {
      logError({
        source: "mongodb",
        severity: "medium",
        message: "Geospatial search failed",
        error: err,
      });
      return NextResponse.json({ error: "Search unavailable" }, { status: 503 });
    }
  }

  // Mode: text search (with optional tag filter)
  if (!q && !tag) {
    return NextResponse.json({ error: "Provide q (search query) or tag (filter)" }, { status: 400 });
  }

  // Try MongoDB text search first
  try {
    const result = await searchLocationsFromDb(q, { tag, limit, skip });
    return NextResponse.json({ ...result, source: "mongodb" });
  } catch (err) {
    logError({
      source: "mongodb",
      severity: "medium",
      message: "Text search failed",
      error: err,
    });
    return NextResponse.json({ error: "Search unavailable" }, { status: 503 });
  }
}
