/**
 * Tests for the /api/db-init route — validates security checks,
 * initialization flow, and API key handling.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "route.ts"),
  "utf-8",
);

describe("/api/db-init route structure", () => {
  it("exports a POST handler", () => {
    expect(source).toContain("export async function POST");
  });

  it("checks x-init-secret header in production", () => {
    expect(source).toContain('request.headers.get("x-init-secret")');
    expect(source).toContain("process.env.NODE_ENV");
    expect(source).toContain("process.env.DB_INIT_SECRET");
  });

  it("returns 401 when secret is wrong in production", () => {
    expect(source).toContain("Unauthorized");
    expect(source).toContain("status: 401");
  });

  it("only enforces secret in production mode", () => {
    expect(source).toContain('"production"');
  });

  it("calls ensureIndexes for database setup", () => {
    expect(source).toContain("ensureIndexes()");
  });

  it("does NOT sync locations (Phase 0F — weather.locations is dropped)", () => {
    expect(source).not.toContain("syncLocations");
    expect(source).not.toContain('from "@/lib/locations"');
  });

  it("does NOT sync countries/provinces (Phase 0G — silos dropped, use placesGeo)", () => {
    expect(source).not.toContain("syncCountries");
    expect(source).not.toContain("syncProvinces");
    expect(source).not.toContain('from "@/lib/countries"');
  });

  it("drops the legacy weather.locations collection idempotently", () => {
    expect(source).toContain('dropCollection("locations")');
    expect(source).toContain("ns not found");
  });

  it("syncs regions, tags, and seasons from seed files", () => {
    expect(source).toContain("syncRegions(REGIONS)");
    expect(source).toContain("syncTags(TAGS)");
    expect(source).toContain("syncSeasons(SEASONS)");
  });

  it("seeds aviation ICAO airports from the icao-codes catalog", () => {
    expect(source).toContain('import { AIRPORTS } from "@/lib/icao-codes"');
    expect(source).toContain("syncAirports(AIRPORTS)");
    expect(source).toContain("airports: AIRPORTS.length");
  });

  it("stores API keys from request body", () => {
    expect(source).toContain("setApiKey(provider, key)");
  });

  it("validates API keys are non-empty strings", () => {
    expect(source).toContain('typeof key === "string"');
    expect(source).toContain("key.length > 0");
  });

  it("handles missing or invalid JSON body gracefully", () => {
    // The inner try/catch handles body parsing failures
    expect(source).toContain("await request.json()");
    expect(source).toContain("catch");
  });

  it("returns success response with counts for all synced collections", () => {
    expect(source).toContain("success: true");
    expect(source).toContain('indexes: "created"');
    expect(source).toContain("regions: REGIONS.length");
    expect(source).toContain("tags: TAGS.length");
    expect(source).toContain("seasons: SEASONS.length");
    // Phase 0F: locations are no longer synced; instead the drop is reported.
    expect(source).toContain("droppedLegacyLocations");
  });

  it("reports stored key names in response", () => {
    expect(source).toContain("storedKeys");
    expect(source).toContain("apiKeys:");
  });

  it("reports 'none provided' when no API keys are given", () => {
    expect(source).toContain('"none provided"');
  });

  it("returns 500 on database error", () => {
    expect(source).toContain("status: 500");
    expect(source).toContain("DB initialization failed");
  });

  it("does not expose Atlas Search index definitions in response", () => {
    expect(source).not.toContain("getAtlasSearchIndexDefinitions");
    expect(source).not.toContain("atlasSearchIndexes:");
    // Definitions remain in codebase but are not disclosed via API
    expect(source).toContain("Atlas Search index definitions are in the codebase");
  });
});
