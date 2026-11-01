import { describe, expect, it } from "vitest";
import {
  REPORT_WINDOW_HOURS,
  reportRefusal,
  reportsListUrl,
  reportsSubmitUrl,
  reportsUpvoteUrl,
} from "./reports-api";
import { DEFAULT_WEATHER_API_URL } from "./weather-api";

describe("report URLs (the Rust Worker, never /api/py)", () => {
  it("lists a place's reports for the last day by default", () => {
    expect(reportsListUrl("harare")).toBe(
      `${DEFAULT_WEATHER_API_URL}/v1/reports?location=harare&hours=24`,
    );
    expect(REPORT_WINDOW_HOURS).toBe(24);
  });

  it("encodes the slug and takes another window", () => {
    expect(reportsListUrl("a b&c", 6)).toBe(
      `${DEFAULT_WEATHER_API_URL}/v1/reports?location=a%20b%26c&hours=6`,
    );
  });

  it("submits and upvotes on the same route family", () => {
    expect(reportsSubmitUrl()).toBe(`${DEFAULT_WEATHER_API_URL}/v1/reports`);
    expect(reportsUpvoteUrl()).toBe(
      `${DEFAULT_WEATHER_API_URL}/v1/reports/upvote`,
    );
    for (const url of [
      reportsListUrl("x"),
      reportsSubmitUrl(),
      reportsUpvoteUrl(),
    ]) {
      expect(url).not.toContain("/api/py");
    }
  });
});

describe("reportRefusal", () => {
  it("reads the Worker's error_description first", () => {
    expect(
      reportRefusal(
        { error: "invalid_request", error_description: "Unknown location" },
        "fallback",
      ),
    ).toBe("Unknown location");
  });

  it("still reads FastAPI's detail (the follow-up questions route)", () => {
    expect(reportRefusal({ detail: "Rate limit exceeded" }, "fallback")).toBe(
      "Rate limit exceeded",
    );
  });

  it("falls back on anything else", () => {
    for (const body of [
      null,
      undefined,
      "x",
      3,
      {},
      { detail: 5 },
      { detail: " " },
    ]) {
      expect(reportRefusal(body, "fallback")).toBe("fallback");
    }
  });
});
