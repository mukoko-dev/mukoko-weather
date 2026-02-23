import { describe, it, expect } from "vitest";
import {
  ACTIVITIES,
  ACTIVITY_CATEGORIES,
  CATEGORY_STYLES,
  getActivitiesByCategory,
  getActivityById,
  getActivityLabels,
  getRelevantActivities,
  getDefaultActivitiesForLocation,
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

  it("has activities in every category", () => {
    for (const cat of ACTIVITY_CATEGORIES) {
      const count = ACTIVITIES.filter((a) => a.category === cat.id).length;
      expect(count).toBeGreaterThan(0);
    }
  });
});

describe("ACTIVITY_CATEGORIES", () => {
  it("includes all six category IDs", () => {
    const ids = ACTIVITY_CATEGORIES.map((c) => c.id);
    expect(ids).toContain("farming");
    expect(ids).toContain("mining");
    expect(ids).toContain("travel");
    expect(ids).toContain("tourism");
    expect(ids).toContain("sports");
    expect(ids).toContain("casual");
  });

  it("has broadened labels reflecting African industries", () => {
    const labels = ACTIVITY_CATEGORIES.map((c) => c.label);
    expect(labels).toContain("Agriculture & Forestry");
    expect(labels).toContain("Industry & Construction");
    expect(labels).toContain("Transport & Logistics");
    expect(labels).toContain("Outdoors & Conservation");
    expect(labels).toContain("Sports & Fitness");
    expect(labels).toContain("Lifestyle & Events");
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

describe("expanded activities — Agriculture & Forestry", () => {
  it("includes crop-farming, livestock, horticulture, forestry, beekeeping, aquaculture", () => {
    expect(getActivityById("crop-farming")).toBeDefined();
    expect(getActivityById("livestock")).toBeDefined();
    expect(getActivityById("horticulture")).toBeDefined();
    expect(getActivityById("forestry")).toBeDefined();
    expect(getActivityById("beekeeping")).toBeDefined();
    expect(getActivityById("aquaculture")).toBeDefined();
  });

  it("all agriculture activities are in farming category", () => {
    for (const id of ["crop-farming", "livestock", "horticulture", "gardening", "irrigation", "forestry", "beekeeping", "aquaculture"]) {
      expect(getActivityById(id)!.category).toBe("farming");
    }
  });
});

describe("expanded activities — Industry & Construction", () => {
  it("includes manufacturing, energy, logistics", () => {
    expect(getActivityById("manufacturing")).toBeDefined();
    expect(getActivityById("energy")).toBeDefined();
    expect(getActivityById("logistics")).toBeDefined();
  });

  it("all industry activities are in mining category", () => {
    for (const id of ["mining", "construction", "manufacturing", "energy", "logistics"]) {
      expect(getActivityById(id)!.category).toBe("mining");
    }
  });
});

describe("expanded activities — Transport & Logistics", () => {
  it("includes trucking and shipping", () => {
    expect(getActivityById("trucking")).toBeDefined();
    expect(getActivityById("shipping")).toBeDefined();
  });

  it("all transport activities are in travel category", () => {
    for (const id of ["driving", "commuting", "flying", "trucking", "shipping"]) {
      expect(getActivityById(id)!.category).toBe("travel");
    }
  });
});

describe("expanded activities — Outdoors & Conservation", () => {
  it("includes conservation, wildlife-research, hiking", () => {
    expect(getActivityById("conservation")).toBeDefined();
    expect(getActivityById("wildlife-research")).toBeDefined();
    expect(getActivityById("hiking")).toBeDefined();
  });

  it("hiking moved to tourism (outdoors) category", () => {
    expect(getActivityById("hiking")!.category).toBe("tourism");
  });

  it("conservation activities reference national-park tag", () => {
    expect(getActivityById("conservation")!.relevantTags).toContain("national-park");
    expect(getActivityById("wildlife-research")!.relevantTags).toContain("national-park");
  });
});

describe("expanded activities — Sports & Fitness", () => {
  it("includes athletics and coaching", () => {
    expect(getActivityById("athletics")).toBeDefined();
    expect(getActivityById("coaching")).toBeDefined();
  });

  it("athletics and coaching are in sports category", () => {
    expect(getActivityById("athletics")!.category).toBe("sports");
    expect(getActivityById("coaching")!.category).toBe("sports");
  });
});

describe("expanded activities — Lifestyle & Events", () => {
  it("includes festivals, weddings, health-wellness, education", () => {
    expect(getActivityById("festivals")).toBeDefined();
    expect(getActivityById("weddings")).toBeDefined();
    expect(getActivityById("health-wellness")).toBeDefined();
    expect(getActivityById("education")).toBeDefined();
  });

  it("all lifestyle activities are in casual category", () => {
    for (const id of ["walking", "barbecue", "outdoor-events", "festivals", "weddings", "drone-flying", "picnic", "health-wellness", "education"]) {
      expect(getActivityById(id)!.category).toBe("casual");
    }
  });
});

describe("getDefaultActivitiesForLocation", () => {
  it("returns farming activities for a farming location", () => {
    const defaults = getDefaultActivitiesForLocation(["farming"]);
    // Most results should be from the farming category
    const farmingCount = defaults.filter((a) => a.category === "farming").length;
    expect(farmingCount).toBeGreaterThanOrEqual(4);
  });

  it("returns tourism/outdoors activities for a national-park location", () => {
    const defaults = getDefaultActivitiesForLocation(["national-park", "tourism"]);
    // Most results should be from the tourism (outdoors) category
    const tourismCount = defaults.filter((a) => a.category === "tourism").length;
    expect(tourismCount).toBeGreaterThanOrEqual(4);
  });

  it("respects the limit parameter", () => {
    const defaults = getDefaultActivitiesForLocation(["city"], 3);
    expect(defaults).toHaveLength(3);
  });

  it("includes universal activities (empty relevantTags)", () => {
    const defaults = getDefaultActivitiesForLocation(["farming"], 20);
    const ids = defaults.map((a) => a.id);
    expect(ids).toContain("barbecue"); // barbecue has relevantTags: []
  });

  it("returns empty for completely unmatched tags", () => {
    const defaults = getDefaultActivitiesForLocation(["nonexistent-tag"]);
    // Should still include universal activities
    const ids = defaults.map((a) => a.id);
    expect(ids).toContain("barbecue");
  });
});

describe("CATEGORY_STYLES", () => {
  it("has styles for every activity category", () => {
    for (const cat of ACTIVITY_CATEGORIES) {
      expect(CATEGORY_STYLES[cat.id]).toBeDefined();
      expect(CATEGORY_STYLES[cat.id].bg).toBeTruthy();
      expect(CATEGORY_STYLES[cat.id].border).toBeTruthy();
      expect(CATEGORY_STYLES[cat.id].text).toBeTruthy();
      expect(CATEGORY_STYLES[cat.id].badge).toBeTruthy();
    }
  });

  it("uses mineral color classes for non-casual categories", () => {
    expect(CATEGORY_STYLES.farming.text).toContain("mineral-malachite");
    expect(CATEGORY_STYLES.mining.text).toContain("mineral-terracotta");
    expect(CATEGORY_STYLES.travel.text).toContain("mineral-cobalt");
    expect(CATEGORY_STYLES.tourism.text).toContain("mineral-tanzanite");
    expect(CATEGORY_STYLES.sports.text).toContain("mineral-gold");
  });

  it("uses primary color for casual category", () => {
    expect(CATEGORY_STYLES.casual.text).toContain("text-primary");
    expect(CATEGORY_STYLES.casual.border).toContain("border-primary");
  });

  it("includes bg, border, text, and badge for each style", () => {
    for (const [, style] of Object.entries(CATEGORY_STYLES)) {
      expect(style.bg).toMatch(/^bg-/);
      expect(style.border).toMatch(/^border-/);
      expect(style.text).toMatch(/^text-/);
      expect(style.badge).toContain("bg-");
    }
  });
});
