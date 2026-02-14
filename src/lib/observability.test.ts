import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  logError,
  logWarn,
  reportErrorToAnalytics,
  reportProviderFailure,
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
