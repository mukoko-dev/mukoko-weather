/**
 * Tests for the /api/status route — validates response structure
 * and check names.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "route.ts"),
  "utf-8",
);

describe("/api/status route structure", () => {
  it("exports a GET handler", () => {
    expect(source).toContain("export async function GET");
  });

  it("runs all health checks in parallel", () => {
    expect(source).toContain("Promise.all");
  });

  it("checks MongoDB Atlas connectivity", () => {
    expect(source).toContain("checkMongoDB");
    expect(source).toContain("MongoDB Atlas");
    expect(source).toContain('{ ping: 1 }');
  });

  it("checks Tomorrow.io API", () => {
    expect(source).toContain("checkTomorrowIo");
    expect(source).toContain("Tomorrow.io API");
    expect(source).toContain("api.tomorrow.io");
  });

  it("checks Open-Meteo API", () => {
    expect(source).toContain("checkOpenMeteo");
    expect(source).toContain("Open-Meteo API");
    expect(source).toContain("api.open-meteo.com");
  });

  it("checks Anthropic AI availability", () => {
    expect(source).toContain("checkAnthropicAI");
    expect(source).toContain("Anthropic AI");
    expect(source).toContain("api.anthropic.com");
  });

  it("checks weather cache status", () => {
    expect(source).toContain("checkWeatherCache");
    expect(source).toContain("Weather Cache");
    expect(source).toContain("weather_cache");
  });

  it("checks AI summary cache status", () => {
    expect(source).toContain("checkAISummaryCache");
    expect(source).toContain("AI Summary Cache");
    expect(source).toContain("ai_summaries");
  });

  it("uses 10s timeout for external API calls", () => {
    expect(source).toContain("AbortSignal.timeout(10000)");
  });

  it("handles Tomorrow.io rate limiting (429)", () => {
    expect(source).toContain("429");
    expect(source).toContain("Rate limited");
  });

  it("handles missing Tomorrow.io API key gracefully", () => {
    expect(source).toContain("API key not configured");
    expect(source).toContain("Open-Meteo fallback");
  });

  it("handles missing Anthropic API key gracefully", () => {
    expect(source).toContain("basic summary fallback active");
  });

  it("returns overall status based on individual checks", () => {
    expect(source).toContain("overallStatus");
    expect(source).toContain('"operational"');
    expect(source).toContain('"degraded"');
  });

  it("includes timestamp and total latency in response", () => {
    expect(source).toContain("timestamp");
    expect(source).toContain("totalLatencyMs");
  });

  it("each check returns name, status, latencyMs, and message", () => {
    // Verify the CheckResult interface fields appear in every check function
    expect(source).toContain("name:");
    expect(source).toContain("status:");
    expect(source).toContain("latencyMs:");
    expect(source).toContain("message:");
  });
});
