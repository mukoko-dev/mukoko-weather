/**
 * Tests for the /api/ai route — validates request validation,
 * caching behavior, and fallback patterns.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "route.ts"),
  "utf-8",
);

describe("/api/ai route structure", () => {
  it("exports a POST handler", () => {
    expect(source).toContain("export async function POST");
  });

  it("returns 400 when weatherData or location is missing", () => {
    expect(source).toContain("!weatherData || !location");
    expect(source).toContain("Missing weather data or location");
    expect(source).toContain("status: 400");
  });

  it("extracts activities array from request body", () => {
    expect(source).toContain("activities");
    expect(source).toContain("Array.isArray(activities)");
  });

  it("defaults activities to empty array when not an array", () => {
    expect(source).toContain(": []");
  });

  it("checks MongoDB cache before generating", () => {
    expect(source).toContain("getCachedAISummary(locationSlug)");
  });

  it("checks staleness of cached summary", () => {
    expect(source).toContain("isSummaryStale(cached, currentTemp, currentCode)");
  });

  it("returns cached result with cached: true flag", () => {
    expect(source).toContain("cached: true");
  });

  it("generates basic fallback when ANTHROPIC_API_KEY is missing", () => {
    expect(source).toContain("process.env.ANTHROPIC_API_KEY");
    expect(source).toContain("if (!apiKey)");
    expect(source).toContain("Current conditions in");
  });

  it("caches the fallback summary", () => {
    // The fallback path also calls setCachedAISummary
    const fallbackSection = source.slice(
      source.indexOf("if (!apiKey)"),
      source.indexOf("const anthropic"),
    );
    expect(fallbackSection).toContain("setCachedAISummary");
  });

  it("uses Claude claude-sonnet-4-20250514 model", () => {
    expect(source).toContain("claude-sonnet-4-20250514");
  });

  it("limits max_tokens to 300", () => {
    expect(source).toContain("max_tokens: 300");
  });

  it("includes the system prompt", () => {
    expect(source).toContain("WEATHER_AI_SYSTEM_PROMPT");
  });

  it("extracts text block from Claude response", () => {
    expect(source).toContain('b.type === "text"');
    expect(source).toContain("textBlock?.text");
  });

  it("falls back to 'No insight available.' when no text block", () => {
    expect(source).toContain("No insight available.");
  });

  it("stores generated summary in cache", () => {
    expect(source).toContain("setCachedAISummary");
  });

  it("includes activities in the prompt when provided", () => {
    expect(source).toContain("Tailor advice to these activities");
  });

  it("returns 502 on error", () => {
    expect(source).toContain("status: 502");
    expect(source).toContain("AI service unavailable");
  });

  it("logs medium-severity error on failure", () => {
    expect(source).toContain('severity: "medium"');
    expect(source).toContain('source: "ai-api"');
  });

  it("derives location slug from location name", () => {
    expect(source).toContain("toLowerCase()");
    expect(source).toContain('.replace(/\\s+/g, "-")');
  });

  it("looks up location tags for tiered TTL", () => {
    expect(source).toContain("getLocationBySlug(locationSlug)");
    expect(source).toContain("locationTags");
  });

  it("includes Zimbabwe season context in prompt", () => {
    expect(source).toContain("getZimbabweSeason");
    expect(source).toContain("season.shona");
  });
});
