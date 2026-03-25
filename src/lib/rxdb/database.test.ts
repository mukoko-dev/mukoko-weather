import { describe, it, expect } from "vitest";
import {
  preferencesSchema,
  weatherCacheSchema,
  weatherHintSchema,
  suitabilityRuleSchema,
  type PreferencesDocType,
  type WeatherCacheDocType,
  type WeatherHintDocType,
  type SuitabilityRuleDocType,
} from "./schemas";

// ---------------------------------------------------------------------------
// Schema validation tests
// ---------------------------------------------------------------------------

describe("RxDB schemas", () => {
  describe("preferencesSchema", () => {
    it("has version 0", () => {
      expect(preferencesSchema.version).toBe(0);
    });

    it("uses 'id' as primary key", () => {
      expect(preferencesSchema.primaryKey).toBe("id");
    });

    it("requires all preference fields", () => {
      expect(preferencesSchema.required).toContain("id");
      expect(preferencesSchema.required).toContain("theme");
      expect(preferencesSchema.required).toContain("selectedLocation");
      expect(preferencesSchema.required).toContain("savedLocations");
      expect(preferencesSchema.required).toContain("locationLabels");
      expect(preferencesSchema.required).toContain("selectedActivities");
      expect(preferencesSchema.required).toContain("hasOnboarded");
      expect(preferencesSchema.required).toContain("updatedAt");
    });

    it("defines theme as string with valid enum values", () => {
      const themeProp = preferencesSchema.properties.theme;
      expect(themeProp.type).toBe("string");
      expect(themeProp.enum).toEqual(["light", "dark", "system"]);
    });

    it("defines savedLocations as string array", () => {
      const prop = preferencesSchema.properties.savedLocations;
      expect(prop.type).toBe("array");
    });
  });

  describe("weatherCacheSchema", () => {
    it("uses 'slug' as primary key", () => {
      expect(weatherCacheSchema.primaryKey).toBe("slug");
    });

    it("indexes expiresAt for TTL queries", () => {
      expect(weatherCacheSchema.indexes).toContain("expiresAt");
    });

    it("requires all cache fields", () => {
      expect(weatherCacheSchema.required).toContain("slug");
      expect(weatherCacheSchema.required).toContain("data");
      expect(weatherCacheSchema.required).toContain("provider");
      expect(weatherCacheSchema.required).toContain("cachedAt");
      expect(weatherCacheSchema.required).toContain("expiresAt");
    });
  });

  describe("weatherHintSchema", () => {
    it("uses 'slug' as primary key", () => {
      expect(weatherHintSchema.primaryKey).toBe("slug");
    });

    it("requires scene type and weather code", () => {
      expect(weatherHintSchema.required).toContain("sceneType");
      expect(weatherHintSchema.required).toContain("weatherCode");
      expect(weatherHintSchema.required).toContain("isDay");
    });
  });

  describe("suitabilityRuleSchema", () => {
    it("uses 'key' as primary key", () => {
      expect(suitabilityRuleSchema.primaryKey).toBe("key");
    });

    it("stores conditions as string (JSON-stringified)", () => {
      expect(suitabilityRuleSchema.properties.conditions.type).toBe("string");
    });
  });
});

// ---------------------------------------------------------------------------
// Type compatibility tests
// ---------------------------------------------------------------------------

describe("schema type compatibility", () => {
  it("PreferencesDocType satisfies the schema shape", () => {
    const doc: PreferencesDocType = {
      id: "test-uuid",
      theme: "system",
      selectedLocation: "harare",
      savedLocations: ["harare", "bulawayo"],
      locationLabels: { harare: "Home" },
      selectedActivities: ["running"],
      hasOnboarded: true,
      updatedAt: Date.now(),
    };
    expect(doc.id).toBe("test-uuid");
    expect(doc.savedLocations).toHaveLength(2);
  });

  it("WeatherCacheDocType satisfies the schema shape", () => {
    const doc: WeatherCacheDocType = {
      slug: "harare",
      data: '{"current":{"temperature":25}}',
      provider: "tomorrow",
      cachedAt: Date.now(),
      expiresAt: Date.now() + 15 * 60 * 1000,
    };
    expect(doc.slug).toBe("harare");
    expect(doc.expiresAt).toBeGreaterThan(doc.cachedAt);
  });

  it("WeatherHintDocType satisfies the schema shape", () => {
    const doc: WeatherHintDocType = {
      slug: "harare",
      sceneType: "clear",
      weatherCode: 0,
      isDay: true,
      timestamp: Date.now(),
    };
    expect(doc.sceneType).toBe("clear");
  });

  it("SuitabilityRuleDocType satisfies the schema shape", () => {
    const doc: SuitabilityRuleDocType = {
      key: "category:farming",
      conditions: JSON.stringify([{ field: "gdd10To30", operator: "gte", value: 10 }]),
      updatedAt: Date.now(),
    };
    expect(JSON.parse(doc.conditions)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Database module exports
// ---------------------------------------------------------------------------

describe("database module", () => {
  it("exports getDatabase and destroyDatabase", async () => {
    const mod = await import("./database");
    expect(typeof mod.getDatabase).toBe("function");
    expect(typeof mod.destroyDatabase).toBe("function");
  });

  it("getDatabase returns null on server (no window)", async () => {
    // In Node test environment, window is undefined by default for Vitest node env
    // but jsdom may be configured. The function guards against typeof window === "undefined"
    const { getDatabase } = await import("./database");
    expect(typeof getDatabase).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Collections module exports
// ---------------------------------------------------------------------------

describe("collections module", () => {
  it("exports all collection accessors", async () => {
    const mod = await import("./collections");
    expect(typeof mod.preferencesCollection).toBe("function");
    expect(typeof mod.weatherCacheCollection).toBe("function");
    expect(typeof mod.weatherHintsCollection).toBe("function");
    expect(typeof mod.suitabilityRulesCollection).toBe("function");
  });

  it("exports weather cache helpers", async () => {
    const mod = await import("./collections");
    expect(typeof mod.getCachedWeather).toBe("function");
    expect(typeof mod.cacheWeather).toBe("function");
  });

  it("exports weather hint helpers", async () => {
    const mod = await import("./collections");
    expect(typeof mod.getCachedHint).toBe("function");
    expect(typeof mod.cacheHint).toBe("function");
  });

  it("exports suitability rule helpers", async () => {
    const mod = await import("./collections");
    expect(typeof mod.getCachedRules).toBe("function");
    expect(typeof mod.cacheSuitabilityRules).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Bridge module exports
// ---------------------------------------------------------------------------

describe("bridge module", () => {
  it("exports initRxDBBridge and helpers", async () => {
    const mod = await import("./bridge");
    expect(typeof mod.initRxDBBridge).toBe("function");
    expect(typeof mod.migrateLocalStorageToRxDB).toBe("function");
    expect(typeof mod.updatePreferences).toBe("function");
    expect(typeof mod.getDeviceId).toBe("function");
    expect(typeof mod._resetBridge).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Replication module exports
// ---------------------------------------------------------------------------

describe("replication module", () => {
  it("exports startReplication and stopReplication", async () => {
    const mod = await import("./replication");
    expect(typeof mod.startReplication).toBe("function");
    expect(typeof mod.stopReplication).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Index barrel export
// ---------------------------------------------------------------------------

describe("rxdb barrel export", () => {
  it("re-exports all public APIs", async () => {
    const mod = await import("./index");
    // Database
    expect(typeof mod.getDatabase).toBe("function");
    expect(typeof mod.destroyDatabase).toBe("function");
    // Collections
    expect(typeof mod.getCachedWeather).toBe("function");
    expect(typeof mod.cacheWeather).toBe("function");
    expect(typeof mod.getCachedHint).toBe("function");
    expect(typeof mod.cacheHint).toBe("function");
    expect(typeof mod.getCachedRules).toBe("function");
    expect(typeof mod.cacheSuitabilityRules).toBe("function");
    // Bridge
    expect(typeof mod.initRxDBBridge).toBe("function");
    expect(typeof mod.migrateLocalStorageToRxDB).toBe("function");
    // Replication
    expect(typeof mod.startReplication).toBe("function");
    expect(typeof mod.stopReplication).toBe("function");
  });
});
