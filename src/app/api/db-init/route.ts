import { NextResponse } from "next/server";
import { ensureIndexes, syncActivities, syncRegions, syncTags, syncSeasons, syncSuitabilityRules, syncActivityCategories, syncAIPrompts, syncAISuggestedRules, syncAirports, setApiKey } from "@/lib/db";
import { weatherDb } from "@/lib/mongo";
import { ACTIVITIES } from "@/lib/activities";
import { REGIONS } from "@/lib/seed-regions";
import { TAGS } from "@/lib/seed-tags";
import { SEASONS } from "@/lib/seed-seasons";
import { SUITABILITY_RULES } from "@/lib/seed-suitability-rules";
import { CATEGORIES } from "@/lib/seed-categories";
import { AI_PROMPTS, AI_SUGGESTED_PROMPT_RULES } from "@/lib/seed-ai-prompts";
import { AIRPORTS } from "@/lib/icao-codes";

/**
 * POST /api/db-init
 *
 * One-time (idempotent) endpoint to:
 *   1. Create MongoDB indexes (TTL indexes, unique indexes)
 *   2. Sync all seed data into MongoDB (locations, activities, categories, etc.)
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
    // Parse optional body for API keys + destructive flags
    let apiKeys: Record<string, string> = {};
    let dropLegacyLocations = false;
    try {
      const body = await request.json();
      if (body?.apiKeys && typeof body.apiKeys === "object") {
        apiKeys = body.apiKeys;
      }
      // Phase 0F: destructive drop of `weather.locations` is OPT-IN so a
      // routine db-init never wipes the collection while Python readers are
      // still being migrated. Set `{ "dropLegacyLocations": true }` in the
      // request body once Python is fully migrated to read from placesGeo.
      if (body?.dropLegacyLocations === true) {
        dropLegacyLocations = true;
      }
    } catch {
      // No body or invalid JSON — that's fine, keys are optional
    }

    await ensureIndexes();
    // Sync reference seed data to independent collections — run all in parallel.
    // Phase 0F: location seeding is gone. Mukoko-weather no longer maintains
    // its own siloed `weather.locations` collection — location reads go
    // through `places.placesGeo` via `src/lib/places.ts`.
    // Phase 0G: country/province seeding is gone too — the canonical geographic
    // hierarchy lives in `places.placesGeo` (Fundi-seeded); display/flag data
    // comes from the static COUNTRIES/PROVINCES arrays in `src/lib/countries.ts`.
    await Promise.all([
      syncRegions(REGIONS),
      syncTags(TAGS),
      syncSeasons(SEASONS),
      syncActivityCategories(CATEGORIES),
      syncActivities(ACTIVITIES),
      syncSuitabilityRules(SUITABILITY_RULES),
      syncAIPrompts(AI_PROMPTS),
      syncAISuggestedRules(AI_SUGGESTED_PROMPT_RULES),
      // Aviation ICAO airports → weather.airports (2dsphere for $nearSphere).
      syncAirports(AIRPORTS),
    ]);

    // Drop the legacy `weather.locations` collection — opt-in only.
    // Idempotent: a missing collection is fine, only real errors propagate.
    let droppedLegacyLocations = false;
    if (dropLegacyLocations) {
      try {
        const dropped = await weatherDb().dropCollection("locations");
        droppedLegacyLocations = !!dropped;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("ns not found")) {
          console.warn("[db-init] Could not drop weather.locations:", msg);
        }
      }
    }

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
      activities: ACTIVITIES.length,
      categories: CATEGORIES.length,
      suitabilityRules: SUITABILITY_RULES.length,
      regions: REGIONS.length,
      tags: TAGS.length,
      seasons: SEASONS.length,
      aiPrompts: AI_PROMPTS.length,
      aiSuggestedRules: AI_SUGGESTED_PROMPT_RULES.length,
      airports: AIRPORTS.length,
      apiKeys: storedKeys.length > 0 ? storedKeys : "none provided",
      droppedLegacyLocations,
      // Atlas Search index definitions are in the codebase (db.ts) — not
      // included in the response to avoid unnecessary schema disclosure.
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: "DB initialization failed", details: message }, { status: 500 });
  }
}
