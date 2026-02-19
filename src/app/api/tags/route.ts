import { NextRequest, NextResponse } from "next/server";
import { getAllTagsFromDb, getFeaturedTagsFromDb } from "@/lib/db";
import { logError } from "@/lib/observability";

/**
 * GET /api/tags
 * GET /api/tags?featured=true
 *
 * Returns tag metadata from MongoDB.
 * Tags power the /explore page cards and /explore/[tag] pages.
 */
export async function GET(request: NextRequest) {
  const featured = request.nextUrl.searchParams.get("featured") === "true";

  try {
    const tags = featured ? await getFeaturedTagsFromDb() : await getAllTagsFromDb();
    return NextResponse.json({ tags }, {
      headers: { "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" },
    });
  } catch (err) {
    logError({
      source: "mongodb",
      severity: "medium",
      message: "Failed to fetch tags",
      error: err,
    });
    return NextResponse.json({ error: "Failed to fetch tags" }, { status: 500 });
  }
}
