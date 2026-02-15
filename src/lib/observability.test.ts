import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  logError,
  logWarn,
  reportErrorToAnalytics,
  reportProviderFailure,
  sendAlert,
  buildIssueUrl,
} from "./observability";

describe("logError", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("logs structured JSON with required fields", () => {
    logError({
      source: "weather-api",
      severity: "critical",
      message: "Test error",
    });

    expect(consoleSpy).toHaveBeenCalledOnce();
    const logged = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(logged.level).toBe("error");
    expect(logged.source).toBe("weather-api");
    expect(logged.severity).toBe("critical");
    expect(logged.message).toBe("Test error");
    expect(logged.ts).toBeDefined();
  });

  it("includes location when provided", () => {
    logError({
      source: "weather-api",
      severity: "high",
      location: "harare",
      message: "Location error",
    });

    const logged = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(logged.location).toBe("harare");
  });

  it("includes errorName and stack for Error objects", () => {
    const testError = new Error("Something broke");
    logError({
      source: "mongodb",
      severity: "critical",
      message: "DB error",
      error: testError,
    });

    const logged = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(logged.errorName).toBe("Error");
    expect(logged.stack).toBeDefined();
    expect(logged.stack).toContain("Something broke");
  });

  it("includes errorValue for non-Error objects", () => {
    logError({
      source: "weather-api",
      severity: "low",
      message: "String error",
      error: "simple string error",
    });

    const logged = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(logged.errorValue).toBe("simple string error");
  });

  it("omits error fields when error is undefined", () => {
    logError({
      source: "weather-api",
      severity: "medium",
      message: "No error object",
    });

    const logged = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(logged.errorName).toBeUndefined();
    expect(logged.errorValue).toBeUndefined();
    expect(logged.stack).toBeUndefined();
  });

  it("includes meta when provided", () => {
    logError({
      source: "weather-api",
      severity: "low",
      message: "With meta",
      meta: { lat: -17.83, lon: 31.05 },
    });

    const logged = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(logged.meta).toEqual({ lat: -17.83, lon: 31.05 });
  });

  it("omits meta when not provided", () => {
    logError({
      source: "weather-api",
      severity: "low",
      message: "No meta",
    });

    const logged = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(logged.meta).toBeUndefined();
  });
});

describe("logWarn", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("logs structured JSON with warn level", () => {
    logWarn({
      source: "tomorrow-io",
      message: "Rate limited",
    });

    expect(consoleSpy).toHaveBeenCalledOnce();
    const logged = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(logged.level).toBe("warn");
    expect(logged.source).toBe("tomorrow-io");
    expect(logged.message).toBe("Rate limited");
    expect(logged.ts).toBeDefined();
  });

  it("does not include severity field", () => {
    logWarn({
      source: "open-meteo",
      message: "Fallback used",
    });

    const logged = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(logged.severity).toBeUndefined();
  });

  it("includes meta when provided", () => {
    logWarn({
      source: "weather-api",
      message: "Test",
      meta: { key: "value" },
    });

    const logged = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(logged.meta).toEqual({ key: "value" });
  });
});

describe("reportErrorToAnalytics", () => {
  it("is a no-op when window is undefined (server-side)", () => {
    const originalWindow = globalThis.window;
    // @ts-expect-error - testing SSR
    delete globalThis.window;

    // Should not throw
    expect(() => reportErrorToAnalytics("test error")).not.toThrow();

    globalThis.window = originalWindow;
  });

  it("calls gtag when available in browser", () => {
    const mockGtag = vi.fn();
    const originalWindow = globalThis.window;
    // @ts-expect-error - mock window
    globalThis.window = { gtag: mockGtag };

    reportErrorToAnalytics("test description", true);

    expect(mockGtag).toHaveBeenCalledWith("event", "exception", {
      description: "test description",
      fatal: true,
    });

    globalThis.window = originalWindow;
  });

  it("truncates descriptions to 150 characters", () => {
    const mockGtag = vi.fn();
    const originalWindow = globalThis.window;
    // @ts-expect-error - mock window
    globalThis.window = { gtag: mockGtag };

    const longDescription = "a".repeat(200);
    reportErrorToAnalytics(longDescription);

    const calledDescription = mockGtag.mock.calls[0][2].description;
    expect(calledDescription.length).toBe(150);

    globalThis.window = originalWindow;
  });

  it("defaults fatal to false", () => {
    const mockGtag = vi.fn();
    const originalWindow = globalThis.window;
    // @ts-expect-error - mock window
    globalThis.window = { gtag: mockGtag };

    reportErrorToAnalytics("test");

    expect(mockGtag.mock.calls[0][2].fatal).toBe(false);

    globalThis.window = originalWindow;
  });

  it("does nothing when gtag is not defined", () => {
    const originalWindow = globalThis.window;
    // @ts-expect-error - mock window without gtag
    globalThis.window = {};

    expect(() => reportErrorToAnalytics("test")).not.toThrow();

    globalThis.window = originalWindow;
  });
});

describe("sendAlert", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    vi.stubEnv("ALERT_WEBHOOK_URL", "");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("does nothing when ALERT_WEBHOOK_URL is not set", () => {
    sendAlert({
      source: "weather-api",
      severity: "critical",
      message: "Test alert",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does nothing for low severity events", () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "https://hooks.slack.com/test");

    sendAlert({
      source: "weather-api",
      severity: "low",
      message: "Minor issue",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does nothing for medium severity events", () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "https://hooks.slack.com/test");

    sendAlert({
      source: "weather-api",
      severity: "medium",
      message: "Medium issue",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends webhook for high severity events", () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "https://hooks.slack.com/test");

    sendAlert({
      source: "weather-api",
      severity: "high",
      message: "High severity alert",
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://hooks.slack.com/test");
    expect(options).toHaveProperty("method", "POST");

    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.text).toContain("HIGH");
    expect(body.mukoko_alert.source).toBe("weather-api");
    expect(body.mukoko_alert.severity).toBe("high");
    expect(body.mukoko_alert.message).toBe("High severity alert");
  });

  it("sends webhook for critical severity events", () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "https://hooks.slack.com/test");

    sendAlert({
      source: "mongodb",
      severity: "critical",
      message: "DB connection lost",
      location: "harare",
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.mukoko_alert.location).toBe("harare");
  });

  it("deduplicates identical alerts within cooldown window", () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "https://hooks.slack.com/test");

    // First call — should send
    sendAlert({
      source: "weather-api",
      severity: "high",
      message: "Dedupe test unique message",
    });

    // Second identical call — should be deduped
    sendAlert({
      source: "weather-api",
      severity: "high",
      message: "Dedupe test unique message",
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});

describe("buildIssueUrl", () => {
  it("returns a GitHub issue URL with template and title", () => {
    const url = buildIssueUrl({ title: "Test error" });
    expect(url).toContain("github.com/nyuchitech/mukoko-weather/issues/new");
    expect(url).toContain("template=bug_report.yml");
    expect(url).toContain("title=%5BBug%5D+Test+error");
  });

  it("includes error context in the body", () => {
    const url = buildIssueUrl({
      title: "Weather error",
      source: "location",
      message: "Failed to load",
      page: "/harare",
      digest: "abc123",
    });
    expect(url).toContain("body=");
    // URLSearchParams encodes spaces as +, so replace + with space after decoding
    const decoded = decodeURIComponent(url).replace(/\+/g, " ");
    expect(decoded).toContain("**Error:** Failed to load");
    expect(decoded).toContain("**Source:** location");
    expect(decoded).toContain("**Page:** /harare");
    expect(decoded).toContain("**Digest:** abc123");
  });

  it("omits empty fields from the body", () => {
    const url = buildIssueUrl({ title: "Simple error" });
    const decoded = decodeURIComponent(url).replace(/\+/g, " ");
    expect(decoded).not.toContain("**Error:**");
    expect(decoded).not.toContain("**Source:**");
  });
});

describe("reportProviderFailure", () => {
  it("formats description as provider:errorType", () => {
    const mockGtag = vi.fn();
    const originalWindow = globalThis.window;
    // @ts-expect-error - mock window
    globalThis.window = { gtag: mockGtag };

    reportProviderFailure("tomorrow-io", "rate-limit");

    expect(mockGtag.mock.calls[0][2].description).toBe(
      "tomorrow-io:rate-limit",
    );

    globalThis.window = originalWindow;
  });

  it("includes location when provided", () => {
    const mockGtag = vi.fn();
    const originalWindow = globalThis.window;
    // @ts-expect-error - mock window
    globalThis.window = { gtag: mockGtag };

    reportProviderFailure("open-meteo", "timeout", "harare");

    expect(mockGtag.mock.calls[0][2].description).toBe(
      "open-meteo:timeout:harare",
    );

    globalThis.window = originalWindow;
  });

  it("always reports as non-fatal", () => {
    const mockGtag = vi.fn();
    const originalWindow = globalThis.window;
    // @ts-expect-error - mock window
    globalThis.window = { gtag: mockGtag };

    reportProviderFailure("mongodb", "connection-error");

    expect(mockGtag.mock.calls[0][2].fatal).toBe(false);

    globalThis.window = originalWindow;
  });
});
