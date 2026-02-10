import { NextResponse } from "next/server";
import { ensureIndexes, syncLocations, setApiKey } from "@/lib/db";
import { LOCATIONS } from "@/lib/locations";

/**
 * POST /api/db-init
 *
 * One-time (idempotent) endpoint to:
 *   1. Create MongoDB indexes (TTL indexes, unique indexes)
 *   2. Sync all 90+ locations from the static array into MongoDB
 *   3. Optionally store API keys (Tomorrow.io, Stytch, etc.)
 *
 * Call this once after deployment or when the schema changes.
 * Protected by a simple secret check in production.
 *
 * Body (optional JSON):
 *   { "apiKeys": { "tomorrow": "...", "stytch": "..." } }
 */
export async function POST(request: Request) {
  // Simple protection: require a secret header in production
  const secret = request.headers.get("x-init-secret");
  if (process.env.NODE_ENV === "production" && secret !== process.env.DB_INIT_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Parse optional body for API keys
    let apiKeys: Record<string, string> = {};
    try {
      const body = await request.json();
      if (body?.apiKeys && typeof body.apiKeys === "object") {
        apiKeys = body.apiKeys;
      }
    } catch {
      // No body or invalid JSON — that's fine, keys are optional
    }

    await ensureIndexes();
    await syncLocations(LOCATIONS);

    // Store any provided API keys
    const storedKeys: string[] = [];
    for (const [provider, key] of Object.entries(apiKeys)) {
      if (typeof key === "string" && key.length > 0) {
        await setApiKey(provider, key);
        storedKeys.push(provider);
      }
    }

    return NextResponse.json({
      success: true,
      indexes: "created",
      locations: LOCATIONS.length,
      apiKeys: storedKeys.length > 0 ? storedKeys : "none provided",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: "DB initialization failed", details: message }, { status: 500 });
  }
}
