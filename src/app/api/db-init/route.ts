import { NextResponse } from "next/server";
import { ensureIndexes, syncLocations } from "@/lib/db";
import { LOCATIONS } from "@/lib/locations";

/**
 * POST /api/db-init
 *
 * One-time (idempotent) endpoint to:
 *   1. Create MongoDB indexes (TTL indexes, unique indexes)
 *   2. Sync all 90+ locations from the static array into MongoDB
 *
 * Call this once after deployment or when the schema changes.
 * Protected by a simple secret check in production.
 */
export async function POST(request: Request) {
  // Simple protection: require a secret header in production
  const secret = request.headers.get("x-init-secret");
  if (process.env.NODE_ENV === "production" && secret !== process.env.DB_INIT_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await ensureIndexes();
    await syncLocations(LOCATIONS);

    return NextResponse.json({
      success: true,
      indexes: "created",
      locations: LOCATIONS.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: "DB initialization failed", details: message }, { status: 500 });
  }
}
