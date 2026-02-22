import { NextRequest, NextResponse } from "next/server";
import {
  getAllActivitiesFromDb,
  getActivitiesByCategoryFromDb,
  getActivityByIdFromDb,
  getActivityLabelsFromDb,
  searchActivitiesFromDb,
  getAllActivityCategories,
} from "@/lib/db";
import { logError } from "@/lib/observability";

/**
 * GET /api/activities
 *
 * Query activities from MongoDB. Supports:
 *   ?id=running             — single activity by ID
 *   ?category=farming       — filter by category
 *   ?q=cycling              — text search
 *   ?labels=running,cycling — get labels for IDs (comma-separated)
 *   ?mode=categories        — list categories with styles from DB
 *   (no params)             — all activities
 *
 * ACTIVITIES array in activities.ts is seed data only — this route is the
 * runtime source of truth.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const id = searchParams.get("id");
  const category = searchParams.get("category");
  const q = searchParams.get("q");
  const labels = searchParams.get("labels");
  const mode = searchParams.get("mode");

  try {
    // Mode: list categories with full style metadata from DB
    if (mode === "categories") {
      const categories = await getAllActivityCategories();
      return NextResponse.json({ categories });
    }

    // Single activity by ID
    if (id) {
      const activity = await getActivityByIdFromDb(id);
      if (!activity) {
        return NextResponse.json({ error: "Activity not found" }, { status: 404 });
      }
      return NextResponse.json({ activity });
    }

    // Label lookup for IDs
    if (labels) {
      const ids = labels.split(",").map((s) => s.trim()).filter(Boolean);
      const result = await getActivityLabelsFromDb(ids);
      return NextResponse.json({ labels: result });
    }

    // Text search
    if (q) {
      const activities = await searchActivitiesFromDb(q);
      return NextResponse.json({ activities, total: activities.length });
    }

    // Filter by category
    if (category) {
      const activities = await getActivitiesByCategoryFromDb(category as Parameters<typeof getActivitiesByCategoryFromDb>[0]);
      return NextResponse.json({ activities, total: activities.length });
    }

    // Default: all activities
    const activities = await getAllActivitiesFromDb();
    return NextResponse.json({ activities, total: activities.length });
  } catch (err) {
    logError({
      source: "mongodb",
      severity: "high",
      message: "Activities API query failed",
      error: err,
    });
    return NextResponse.json(
      { error: "Activity data unavailable" },
      { status: 503 },
    );
  }
}
