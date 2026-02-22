import { NextResponse } from "next/server";
import { getAllSuitabilityRules, getSuitabilityRuleByKey } from "@/lib/db";
import { logError } from "@/lib/observability";

/**
 * GET /api/suitability
 *
 * Returns all suitability rules from the database.
 * Used by ActivityInsights to evaluate weather conditions dynamically.
 *
 * Query parameters:
 *   ?key=activity:drone-flying — Get a specific rule by key
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const key = searchParams.get("key");

    // Rules change only on deployment (via db-init), so edge-cache aggressively.
    const cacheHeaders = { "Cache-Control": "s-maxage=300, stale-while-revalidate=60" };

    if (key) {
      // Validate key format: "activity:<id>" or "category:<name>" with alphanumeric + hyphens
      if (!/^(activity|category):[a-z0-9-]+$/.test(key)) {
        return NextResponse.json({ error: "Invalid key format" }, { status: 400 });
      }
      const rule = await getSuitabilityRuleByKey(key);
      if (!rule) {
        return NextResponse.json({ error: "Rule not found" }, { status: 404 });
      }
      return NextResponse.json({ rule }, { headers: cacheHeaders });
    }

    const rules = await getAllSuitabilityRules();
    return NextResponse.json({ rules }, { headers: cacheHeaders });
  } catch (err) {
    logError({
      source: "mongodb",
      severity: "medium",
      message: "Failed to load suitability rules",
      location: "suitability",
      error: err,
    });
    // Short cache on errors to prevent thundering herd during MongoDB outage
    return NextResponse.json({ rules: [] }, {
      headers: { "Cache-Control": "s-maxage=10, stale-while-revalidate=5" },
    });
  }
}
