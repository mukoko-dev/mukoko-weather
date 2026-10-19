import { describe, expect, it } from "vitest";
import {
  validDeviceId,
  validatePatch,
  validatePreferences,
  validateListQuery,
  validateReport,
  validateUpvote,
  ttlSeconds,
  validStorageKey,
  FORECAST_MODELS,
  REPORT_TYPES,
} from "../src/validate";

const report = {
  locationSlug: "harare",
  locationName: "Harare",
  lat: -17.8,
  lon: 31.05,
  reportType: "light-rain",
  severity: "mild",
  description: "drizzle",
  weatherSnapshot: { temperature: 20, weatherCode: 61, precipitation: 0.2, windSpeed: null, humidity: 80 },
  reportedBy: "0123456789abcdef",
  verified: true,
};

describe("device ids and keys", () => {
  it("accepts 1 to 64 of letters, digits, - and _", () => {
    expect(validDeviceId("a")).toBe(true);
    expect(validDeviceId("A_b-9".repeat(12))).toBe(true);
    expect(validDeviceId("a".repeat(65))).toBe(false);
    expect(validDeviceId("")).toBe(false);
    expect(validDeviceId("a b")).toBe(false);
    expect(validDeviceId("a$b")).toBe(false);
    expect(validDeviceId("{$ne:1}")).toBe(false);
  });
  it("storage keys are slugs or geo cells", () => {
    expect(validStorageKey("harare")).toBe(true);
    expect(validStorageKey("geo:ksy4dd7")).toBe(true);
    expect(validStorageKey("geo:abc")).toBe(false);
    expect(validStorageKey("Harare")).toBe(false);
    expect(validStorageKey("a".repeat(81))).toBe(false);
    expect(validStorageKey("$where")).toBe(false);
  });
});

describe("preferences", () => {
  it("fills defaults for a missing object", () => {
    const r = validatePreferences(undefined);
    expect(r).toEqual({
      ok: true,
      value: {
        theme: "system",
        selectedLocation: "",
        savedLocations: [],
        selectedActivities: [],
        hasOnboarded: false,
        selectedForecastModel: "best_match",
      },
    });
  });
  it("rejects each bad field with the Rust detail text", () => {
    expect(validatePreferences({ theme: "neon" })).toEqual({ ok: false, detail: "Invalid theme: neon" });
    expect(validatePreferences({ selectedLocation: "Bad Slug" })).toEqual({
      ok: false,
      detail: "Invalid location slug: Bad Slug",
    });
    expect(validatePreferences({ savedLocations: Array(11).fill("a") })).toEqual({
      ok: false,
      detail: "Too many saved locations (max 10)",
    });
    expect(validatePreferences({ selectedActivities: Array(31).fill("a") })).toEqual({
      ok: false,
      detail: "Too many activities (max 30)",
    });
    expect(validatePreferences({ selectedForecastModel: "nope" })).toEqual({
      ok: false,
      detail: "Invalid forecast model: nope",
    });
    expect(validatePreferences("x").ok).toBe(false);
    expect(validatePreferences({ hasOnboarded: "yes" }).ok).toBe(false);
    expect(validatePreferences({ savedLocations: [1] }).ok).toBe(false);
  });
  it("accepts every known model", () => {
    for (const m of FORECAST_MODELS) {
      expect(validatePreferences({ selectedForecastModel: m }).ok).toBe(true);
    }
  });
});

describe("patch", () => {
  it("becomes dotted $set paths, only for present fields", () => {
    expect(validatePatch({ theme: "dark", hasOnboarded: false })).toEqual({
      ok: true,
      value: { "preferences.theme": "dark", "preferences.hasOnboarded": false },
    });
  });
  it("ignores unknown keys, so no caller path reaches $set", () => {
    const r = validatePatch({ theme: "dark", "createdAt": 1, "preferences.$": 2, deviceId: "x" });
    expect(r).toEqual({ ok: true, value: { "preferences.theme": "dark" } });
  });
  it("an empty patch is an error", () => {
    expect(validatePatch({})).toEqual({ ok: false, detail: "No fields to update" });
    expect(validatePatch({ unknown: 1 })).toEqual({ ok: false, detail: "No fields to update" });
    expect(validatePatch([]).ok).toBe(false);
  });
  it("validates like create", () => {
    expect(validatePatch({ theme: "x" }).ok).toBe(false);
    expect(validatePatch({ selectedLocation: "" }).ok).toBe(true);
  });
});

describe("report", () => {
  it("accepts a good report", () => {
    const r = validateReport(report);
    expect(r.ok).toBe(true);
  });
  it("accepts every report type and rejects others", () => {
    for (const t of REPORT_TYPES) expect(validateReport({ ...report, reportType: t }).ok).toBe(true);
    expect(validateReport({ ...report, reportType: "tornado" }).ok).toBe(false);
  });
  it("rejects a bad severity (the Rust side normalises first)", () => {
    expect(validateReport({ ...report, severity: "extreme" }).ok).toBe(false);
  });
  it("caps the description at 300 characters", () => {
    expect(validateReport({ ...report, description: "x".repeat(300) }).ok).toBe(true);
    expect(validateReport({ ...report, description: "x".repeat(301) }).ok).toBe(false);
  });
  it("treats a missing snapshot as empty and checks numbers", () => {
    const { weatherSnapshot: _omit, ...rest } = report;
    expect(validateReport(rest)).toMatchObject({ ok: true, value: { weatherSnapshot: {} } });
    expect(validateReport({ ...report, weatherSnapshot: { temperature: "hot" } }).ok).toBe(false);
    expect(validateReport({ ...report, weatherSnapshot: { temperature: Infinity } }).ok).toBe(false);
  });
  it("checks coordinates, reporter and key", () => {
    expect(validateReport({ ...report, lat: 91 }).ok).toBe(false);
    expect(validateReport({ ...report, lon: -181 }).ok).toBe(false);
    expect(validateReport({ ...report, lat: null, lon: null }).ok).toBe(true);
    expect(validateReport({ ...report, reportedBy: "nothex" }).ok).toBe(false);
    expect(validateReport({ ...report, locationSlug: "Harare!" }).ok).toBe(false);
    expect(validateReport({ ...report, locationName: "" }).ok).toBe(false);
    expect(validateReport({ ...report, verified: "true" }).ok).toBe(false);
    expect(validateReport(null).ok).toBe(false);
  });
  it("lives 24, 48 or 72 hours by severity", () => {
    expect(ttlSeconds("mild")).toBe(86_400);
    expect(ttlSeconds("moderate")).toBe(172_800);
    expect(ttlSeconds("severe")).toBe(259_200);
  });
});

describe("list query", () => {
  const q = (s: string) => validateListQuery(new URLSearchParams(s));
  it("defaults and clamps", () => {
    expect(q("slug=harare")).toEqual({ ok: true, value: { keys: ["harare"], hours: 24, limit: 20 } });
    expect(q("slug=harare&hours=999&limit=500")).toMatchObject({ value: { hours: 72, limit: 20 } });
    expect(q("slug=harare&hours=0&limit=0")).toMatchObject({ value: { hours: 1, limit: 1 } });
  });
  it("needs 1 to 4 valid, distinct keys", () => {
    expect(q("").ok).toBe(false);
    expect(q("slug=a&slug=b&slug=c&slug=d&slug=e").ok).toBe(false);
    expect(q("slug=BAD").ok).toBe(false);
    expect(q("slug=a&slug=a")).toMatchObject({ value: { keys: ["a"] } });
    expect(q("slug=harare&slug=geo:ksy4dd7")).toMatchObject({ value: { keys: ["harare", "geo:ksy4dd7"] } });
  });
  it("rejects a non-integer hours", () => {
    expect(q("slug=a&hours=x").ok).toBe(false);
  });
});

describe("upvote", () => {
  it("needs a 24-hex id and a 16-hex voter", () => {
    expect(validateUpvote({ reportId: "a".repeat(24), voter: "0".repeat(16) }).ok).toBe(true);
    expect(validateUpvote({ reportId: "a".repeat(23), voter: "0".repeat(16) }).ok).toBe(false);
    expect(validateUpvote({ reportId: { $ne: 1 }, voter: "0".repeat(16) }).ok).toBe(false);
    expect(validateUpvote({ reportId: "a".repeat(24), voter: { $ne: "x" } }).ok).toBe(false);
  });
});
