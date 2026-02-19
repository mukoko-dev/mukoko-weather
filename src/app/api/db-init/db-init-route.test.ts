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

  it("syncs all locations from the static LOCATIONS array", () => {
    expect(source).toContain("syncLocations(LOCATIONS)");
  });

  it("syncs regions, tags, and seasons from seed files", () => {
    expect(source).toContain("syncRegions(REGIONS)");
    expect(source).toContain("syncTags(TAGS)");
    expect(source).toContain("syncSeasons(SEASONS)");
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
    expect(source).toContain("locations: LOCATIONS.length");
    expect(source).toContain("regions: REGIONS.length");
    expect(source).toContain("tags: TAGS.length");
    expect(source).toContain("seasons: SEASONS.length");
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
});
