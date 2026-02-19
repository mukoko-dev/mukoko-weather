import { NextResponse } from "next/server";
import { getActiveRegions } from "@/lib/db";
import { logError } from "@/lib/observability";

/**
 * GET /api/regions
 *
 * Returns all active supported regions from MongoDB.
 * Used by the client to check if a given coordinate is within a supported region.
 */
export async function GET() {
  try {
    const regions = await getActiveRegions();
    return NextResponse.json({ regions }, {
      headers: { "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" },
    });
  } catch (err) {
    logError({
      source: "mongodb",
      severity: "medium",
      message: "Failed to fetch regions",
      error: err,
    });
    return NextResponse.json({ error: "Failed to fetch regions" }, { status: 500 });
  }
}
