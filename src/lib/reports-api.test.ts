import { describe, expect, it } from "vitest";
import {
  CLARIFY_TIMEOUT_MS,
  REPORT_WINDOW_HOURS,
  clarifyQuestions,
  reportRefusal,
  reportsListUrl,
  reportsSubmitUrl,
  reportsUpvoteUrl,
} from "./reports-api";
import {
  DEFAULT_WEATHER_API_URL,
  WORKER_AI_TIMEOUT_MS,
  workerUrl,
} from "./weather-api";

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

  it("does not read FastAPI's detail: no Python route is left", () => {
    expect(reportRefusal({ detail: "Rate limit exceeded" }, "fallback")).toBe(
      "fallback",
    );
  });

  it("falls back on anything else", () => {
    for (const body of [
      null,
      undefined,
      "x",
      3,
      {},
      { error_description: 5 },
      { error_description: " " },
    ]) {
      expect(reportRefusal(body, "fallback")).toBe("fallback");
    }
  });
});

describe("the follow-up questions", () => {
  it("are asked of the Worker's route, never retried, with a wizard-sized wait", () => {
    expect(workerUrl("reports/clarify", "")).toBe(
      `${DEFAULT_WEATHER_API_URL}/v1/reports/clarify`,
    );
    // The Worker answers within ~13 s whatever happens; the wait is longer
    // than that but nowhere near the 40 s of the other AI routes.
    expect(CLARIFY_TIMEOUT_MS).toBeGreaterThan(13_000);
    expect(CLARIFY_TIMEOUT_MS).toBeLessThan(WORKER_AI_TIMEOUT_MS);
  });
});

describe("clarifyQuestions", () => {
  it("reads the Worker's questions, ignoring its source", () => {
    expect(
      clarifyQuestions({
        questions: ["How heavy is it?", "Is water pooling?"],
        source: "ai",
      }),
    ).toEqual(["How heavy is it?", "Is water pooling?"]);
  });

  it("keeps at most two, and only real strings", () => {
    expect(clarifyQuestions({ questions: ["a?", "b?", "c?"] })).toEqual([
      "a?",
      "b?",
    ]);
    expect(clarifyQuestions({ questions: ["a?", 3, " ", null, "b?"] })).toEqual(
      ["a?", "b?"],
    );
  });

  it("is empty for any other shape, so the wizard carries on without", () => {
    for (const body of [
      null,
      undefined,
      "x",
      3,
      [],
      {},
      { questions: "a?" },
      { questions: {} },
      { error: "invalid_request", error_description: "nope" },
    ]) {
      expect(clarifyQuestions(body)).toEqual([]);
    }
  });
});
