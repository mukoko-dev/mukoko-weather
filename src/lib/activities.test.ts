import { describe, it, expect } from "vitest";
import {
  ACTIVITIES,
  ACTIVITY_CATEGORIES,
  getActivitiesByCategory,
  getActivityById,
  getActivityLabels,
  getRelevantActivities,
  searchActivities,
} from "./activities";

describe("ACTIVITIES", () => {
  it("has unique IDs", () => {
    const ids = ACTIVITIES.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every activity has a valid category from ACTIVITY_CATEGORIES", () => {
    const categoryIds = ACTIVITY_CATEGORIES.map((c) => c.id);
    for (const activity of ACTIVITIES) {
      expect(categoryIds).toContain(activity.category);
    }
  });

  it("every activity has non-empty label and description", () => {
    for (const activity of ACTIVITIES) {
      expect(activity.label.length).toBeGreaterThan(0);
      expect(activity.description.length).toBeGreaterThan(0);
    }
  });
});

describe("ACTIVITY_CATEGORIES", () => {
  it("includes location-tag-based categories (farming, mining, travel, tourism)", () => {
    const ids = ACTIVITY_CATEGORIES.map((c) => c.id);
    expect(ids).toContain("farming");
    expect(ids).toContain("mining");
    expect(ids).toContain("travel");
    expect(ids).toContain("tourism");
  });

  it("includes user-activity categories (sports, casual)", () => {
    const ids = ACTIVITY_CATEGORIES.map((c) => c.id);
    expect(ids).toContain("sports");
    expect(ids).toContain("casual");
  });
});

describe("getActivitiesByCategory", () => {
  it("returns only farming activities for 'farming' category", () => {
    const farming = getActivitiesByCategory("farming");
    expect(farming.length).toBeGreaterThan(0);
    for (const a of farming) {
      expect(a.category).toBe("farming");
    }
  });

  it("returns only sports activities for 'sports' category", () => {
    const sports = getActivitiesByCategory("sports");
    expect(sports.length).toBeGreaterThan(0);
    for (const a of sports) {
      expect(a.category).toBe("sports");
    }
  });

  it("returns empty array for unknown category", () => {
    const unknown = getActivitiesByCategory("nonexistent" as never);
    expect(unknown).toHaveLength(0);
  });
});

describe("getActivityById", () => {
  it("returns the correct activity", () => {
    const result = getActivityById("crop-farming");
    expect(result).toBeDefined();
    expect(result!.label).toBe("Crop Farming");
    expect(result!.category).toBe("farming");
  });

  it("returns undefined for unknown ID", () => {
    expect(getActivityById("nonexistent")).toBeUndefined();
  });
});

describe("getActivityLabels", () => {
  it("returns labels for valid IDs", () => {
    const labels = getActivityLabels(["running", "driving", "mining"]);
    expect(labels).toEqual(["Running", "Driving", "Mining"]);
  });

  it("filters out unknown IDs", () => {
    const labels = getActivityLabels(["running", "fake-id", "hiking"]);
    expect(labels).toEqual(["Running", "Hiking"]);
  });

  it("returns empty array for empty input", () => {
    expect(getActivityLabels([])).toEqual([]);
  });
});

describe("getRelevantActivities", () => {
  it("returns activities whose relevantTags overlap with location tags", () => {
    const result = getRelevantActivities(["farming"], ["crop-farming", "running", "livestock"]);
    const ids = result.map((a) => a.id);
    expect(ids).toContain("crop-farming");
    expect(ids).toContain("livestock");
    // running has relevantTags: ["city"], not "farming"
    expect(ids).not.toContain("running");
  });

  it("includes activities with empty relevantTags (universally relevant)", () => {
    const result = getRelevantActivities(["city"], ["barbecue"]);
    expect(result.map((a) => a.id)).toContain("barbecue");
  });

  it("only returns selected activities", () => {
    const result = getRelevantActivities(["farming"], ["crop-farming"]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("crop-farming");
  });
});

describe("searchActivities", () => {
  it("returns all activities for empty query", () => {
    expect(searchActivities("")).toHaveLength(ACTIVITIES.length);
    expect(searchActivities("  ")).toHaveLength(ACTIVITIES.length);
  });

  it("finds activities by label", () => {
    const results = searchActivities("running");
    expect(results.some((a) => a.id === "running")).toBe(true);
  });

  it("finds activities by description", () => {
    const results = searchActivities("braai");
    expect(results.some((a) => a.id === "barbecue")).toBe(true);
  });

  it("finds activities by category", () => {
    const results = searchActivities("sports");
    expect(results.length).toBeGreaterThan(0);
    for (const a of results) {
      expect(a.category).toBe("sports");
    }
  });

  it("is case-insensitive", () => {
    const results = searchActivities("HIKING");
    expect(results.some((a) => a.id === "hiking")).toBe(true);
  });

  it("returns empty array for no matches", () => {
    expect(searchActivities("xyznonexistent")).toHaveLength(0);
  });
});
