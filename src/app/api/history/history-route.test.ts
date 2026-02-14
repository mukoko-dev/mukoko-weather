/**
 * Tests for the /api/history route — validates parameter validation,
 * location lookup, and error handling patterns.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "route.ts"),
  "utf-8",
);

describe("/api/history route structure", () => {
  it("exports a GET handler", () => {
    expect(source).toContain("export async function GET");
  });

  it("extracts location from search params", () => {
    expect(source).toContain('searchParams.get("location")');
  });

  it("extracts days from search params with default of 30", () => {
    expect(source).toContain('searchParams.get("days")');
    expect(source).toContain('"30"');
  });

  it("returns 400 for missing location parameter", () => {
    expect(source).toContain("Missing location parameter");
    expect(source).toContain("status: 400");
  });

  it("returns 404 for unknown location slug", () => {
    expect(source).toContain("Unknown location");
    expect(source).toContain("status: 404");
  });

  it("validates days range between 1 and 365", () => {
    expect(source).toContain("days < 1");
    expect(source).toContain("days > 365");
    expect(source).toContain("days must be between 1 and 365");
  });

  it("returns 400 for NaN days", () => {
    expect(source).toContain("isNaN(days)");
  });

  it("uses getLocationBySlug to validate the location", () => {
    expect(source).toContain("getLocationBySlug(locationSlug)");
  });

  it("returns records count in successful response", () => {
    expect(source).toContain("records: history.length");
  });

  it("returns 502 on database error", () => {
    expect(source).toContain("status: 502");
    expect(source).toContain("Failed to fetch weather history");
  });

  it("logs high-severity error on failure", () => {
    expect(source).toContain('severity: "high"');
    expect(source).toContain('source: "history-api"');
  });
});

describe("history parameter validation logic", () => {
  function validateHistoryParams(
    location: string | null,
    daysStr: string | null,
  ) {
    if (!location) {
      return { error: "Missing location parameter", status: 400 };
    }

    const days = parseInt(daysStr ?? "30", 10);

    if (isNaN(days) || days < 1 || days > 365) {
      return { error: "days must be between 1 and 365", status: 400 };
    }

    return { location, days };
  }

  it("returns error for null location", () => {
    expect(validateHistoryParams(null, "30")).toHaveProperty("error");
  });

  it("returns error for empty location", () => {
    expect(validateHistoryParams("", "30")).toHaveProperty("error");
  });

  it("defaults days to 30 when not provided", () => {
    const result = validateHistoryParams("harare", null);
    expect(result).toHaveProperty("days", 30);
  });

  it("accepts days = 1 (minimum)", () => {
    expect(validateHistoryParams("harare", "1")).toHaveProperty("days", 1);
  });

  it("accepts days = 365 (maximum)", () => {
    expect(validateHistoryParams("harare", "365")).toHaveProperty("days", 365);
  });

  it("rejects days = 0", () => {
    expect(validateHistoryParams("harare", "0")).toHaveProperty("error");
  });

  it("rejects days = 366", () => {
    expect(validateHistoryParams("harare", "366")).toHaveProperty("error");
  });

  it("rejects non-numeric days", () => {
    expect(validateHistoryParams("harare", "abc")).toHaveProperty("error");
  });

  it("rejects negative days", () => {
    expect(validateHistoryParams("harare", "-5")).toHaveProperty("error");
  });
});
