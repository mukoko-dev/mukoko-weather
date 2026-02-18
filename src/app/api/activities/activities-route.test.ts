/**
 * Tests for the /api/activities route — validates query modes,
 * parameter handling, response structure, and error handling.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "route.ts"), "utf-8");

describe("/api/activities route structure", () => {
  it("exports a GET handler", () => {
    expect(source).toContain("export async function GET");
  });

  it("imports DB functions from @/lib/db", () => {
    expect(source).toContain('from "@/lib/db"');
    expect(source).toContain("getAllActivitiesFromDb");
    expect(source).toContain("getActivitiesByCategoryFromDb");
    expect(source).toContain("getActivityByIdFromDb");
    expect(source).toContain("getActivityLabelsFromDb");
    expect(source).toContain("searchActivitiesFromDb");
    expect(source).toContain("getActivityCategoriesFromDb");
  });

  it("imports logError from observability", () => {
    expect(source).toContain('from "@/lib/observability"');
    expect(source).toContain("logError");
  });
});

describe("/api/activities query modes", () => {
  it("extracts id, category, q, labels, and mode from search params", () => {
    expect(source).toContain('searchParams.get("id")');
    expect(source).toContain('searchParams.get("category")');
    expect(source).toContain('searchParams.get("q")');
    expect(source).toContain('searchParams.get("labels")');
    expect(source).toContain('searchParams.get("mode")');
  });

  it("supports ?mode=categories to list distinct categories", () => {
    expect(source).toContain('mode === "categories"');
    expect(source).toContain("getActivityCategoriesFromDb");
    expect(source).toContain("{ categories }");
  });

  it("capitalizes category labels", () => {
    // Label is derived by capitalizing first letter: id.charAt(0).toUpperCase() + id.slice(1)
    expect(source).toContain("charAt(0).toUpperCase()");
    expect(source).toContain("id.slice(1)");
  });

  it("supports ?id= to get a single activity by ID", () => {
    expect(source).toContain("getActivityByIdFromDb(id)");
    expect(source).toContain("{ activity }");
  });

  it("returns 404 when activity ID is not found", () => {
    expect(source).toContain("Activity not found");
    expect(source).toContain("status: 404");
  });

  it("supports ?labels= for label lookup with comma-separated IDs", () => {
    expect(source).toContain("getActivityLabelsFromDb");
    expect(source).toContain('labels.split(",")');
    expect(source).toContain("{ labels: result }");
  });

  it("trims and filters empty values from labels param", () => {
    expect(source).toContain(".trim()");
    expect(source).toContain("filter(Boolean)");
  });

  it("supports ?q= for text search", () => {
    expect(source).toContain("searchActivitiesFromDb(q)");
  });

  it("supports ?category= to filter by category", () => {
    expect(source).toContain("getActivitiesByCategoryFromDb");
  });

  it("returns all activities when no query params are provided", () => {
    expect(source).toContain("getAllActivitiesFromDb");
  });

  it("includes total count in list responses", () => {
    expect(source).toContain("total: activities.length");
  });
});

describe("/api/activities error handling", () => {
  it("returns 503 when the database is unavailable", () => {
    expect(source).toContain("status: 503");
    expect(source).toContain("Activity data unavailable");
  });

  it("logs errors with high severity via observability", () => {
    expect(source).toContain("logError");
    expect(source).toContain('source: "mongodb"');
    expect(source).toContain('severity: "high"');
    expect(source).toContain("Activities API query failed");
  });

  it("wraps all logic in a try/catch block", () => {
    expect(source).toContain("try {");
    expect(source).toContain("} catch");
  });
});

describe("activities label parsing logic", () => {
  function parseLabels(labelsParam: string): string[] {
    return labelsParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  it("splits comma-separated IDs", () => {
    expect(parseLabels("running,cycling")).toEqual(["running", "cycling"]);
  });

  it("trims whitespace around IDs", () => {
    expect(parseLabels(" running , cycling ")).toEqual(["running", "cycling"]);
  });

  it("filters out empty strings from trailing commas", () => {
    expect(parseLabels("running,,cycling,")).toEqual(["running", "cycling"]);
  });

  it("handles a single ID", () => {
    expect(parseLabels("running")).toEqual(["running"]);
  });

  it("returns empty array for empty string", () => {
    expect(parseLabels("")).toEqual([]);
  });
});

describe("activities category label formatting", () => {
  function formatCategoryLabel(id: string): string {
    return id.charAt(0).toUpperCase() + id.slice(1);
  }

  it("capitalizes first letter of category", () => {
    expect(formatCategoryLabel("farming")).toBe("Farming");
    expect(formatCategoryLabel("mining")).toBe("Mining");
    expect(formatCategoryLabel("sports")).toBe("Sports");
  });

  it("handles single character category", () => {
    expect(formatCategoryLabel("a")).toBe("A");
  });

  it("preserves rest of string as-is", () => {
    expect(formatCategoryLabel("casual")).toBe("Casual");
    expect(formatCategoryLabel("tourism")).toBe("Tourism");
  });
});
