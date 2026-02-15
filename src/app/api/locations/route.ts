import { NextRequest, NextResponse } from "next/server";
import {
  getAllLocationsFromDb,
  getLocationFromDb,
  getLocationsByTagFromDb,
  getTagCounts,
  getLocationStats,
} from "@/lib/db";
import { logError } from "@/lib/observability";

/**
 * GET /api/locations
 *
 * Serves location data from MongoDB (the single source of truth).
 *
 * Query params:
 *   slug  - get a single location by slug
 *   tag   - filter locations by tag (city, farming, mining, tourism, etc.)
 *   mode  - "tags" to return tag counts, "all" for all locations (default)
 *
 * Locations are seeded to MongoDB via POST /api/db-init. The static
 * LOCATIONS array in locations.ts is seed data only — it is NOT used
 * for serving. If MongoDB is unavailable, 503 is returned.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const slug = searchParams.get("slug");
  const tag = searchParams.get("tag");
  const mode = searchParams.get("mode");

  try {
    // Single location by slug
    if (slug) {
      const location = await getLocationFromDb(slug);
      if (!location) {
        return NextResponse.json({ error: "Location not found" }, { status: 404 });
      }
      return NextResponse.json({ location });
    }

    // Tag counts
    if (mode === "tags") {
      const tags = await getTagCounts();
      return NextResponse.json({ tags });
    }

    // Location + province counts (for footer stats etc.)
    if (mode === "stats") {
      const stats = await getLocationStats();
      return NextResponse.json(stats);
    }

    // Filtered by tag
    if (tag) {
      const locations = await getLocationsByTagFromDb(tag);
      return NextResponse.json({ locations, total: locations.length });
    }

    // All locations
    const locations = await getAllLocationsFromDb();
    return NextResponse.json({ locations, total: locations.length });
  } catch (err) {
    logError({
      source: "mongodb",
      severity: "high",
      message: "Locations API query failed",
      error: err,
    });
    return NextResponse.json(
      { error: "Location data unavailable" },
      { status: 503 },
    );
  }
}
