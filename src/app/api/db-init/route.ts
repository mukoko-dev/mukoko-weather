import { NextResponse } from "next/server";
import { ensureIndexes, syncLocations, syncActivities, syncCountries, syncProvinces, syncRegions, syncTags, syncSeasons, syncSuitabilityRules, syncActivityCategories, syncAIPrompts, syncAISuggestedRules, setApiKey } from "@/lib/db";
import { LOCATIONS } from "@/lib/locations";
import { ACTIVITIES } from "@/lib/activities";
import { COUNTRIES, PROVINCES } from "@/lib/countries";
import { REGIONS } from "@/lib/seed-regions";
import { TAGS } from "@/lib/seed-tags";
import { SEASONS } from "@/lib/seed-seasons";
import { SUITABILITY_RULES } from "@/lib/seed-suitability-rules";
import { CATEGORIES } from "@/lib/seed-categories";
import { AI_PROMPTS, AI_SUGGESTED_PROMPT_RULES } from "@/lib/seed-ai-prompts";

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
    // Countries must exist before provinces (provinces reference country codes).
    await syncCountries(COUNTRIES);
    // Remaining syncs write to independent collections — run all in parallel.
    await Promise.all([
      syncProvinces(PROVINCES),
      syncRegions(REGIONS),
      syncTags(TAGS),
      syncSeasons(SEASONS),
      syncActivityCategories(CATEGORIES),
      syncLocations(LOCATIONS),
      syncActivities(ACTIVITIES),
      syncSuitabilityRules(SUITABILITY_RULES),
      syncAIPrompts(AI_PROMPTS),
      syncAISuggestedRules(AI_SUGGESTED_PROMPT_RULES),
    ]);

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
      countries: COUNTRIES.length,
      provinces: PROVINCES.length,
      locations: LOCATIONS.length,
      activities: ACTIVITIES.length,
      categories: CATEGORIES.length,
      suitabilityRules: SUITABILITY_RULES.length,
      regions: REGIONS.length,
      tags: TAGS.length,
      seasons: SEASONS.length,
      aiPrompts: AI_PROMPTS.length,
      aiSuggestedRules: AI_SUGGESTED_PROMPT_RULES.length,
      apiKeys: storedKeys.length > 0 ? storedKeys : "none provided",
      // Atlas Search index definitions are in the codebase (db.ts) — not
      // included in the response to avoid unnecessary schema disclosure.
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: "DB initialization failed", details: message }, { status: 500 });
  }
}
