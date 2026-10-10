import { describe, it, expect } from "vitest";
import {
  SITE_URL,
  PROTECTION_BYPASS_HEADER,
  internalApiBase,
  internalApiTarget,
} from "./site";

describe("SITE_URL", () => {
  it("is the canonical production origin with no trailing slash", () => {
    expect(SITE_URL).toBe("https://weather.mukoko.com");
  });
});

describe("internalApiTarget (issue #262)", () => {
  it("falls back to localhost when nothing is configured", () => {
    expect(internalApiTarget({})).toEqual({
      base: "http://localhost:3000",
      headers: {},
    });
  });

  it("lets INTERNAL_API_BASE_URL override everything, even on Vercel", () => {
    const target = internalApiTarget({
      INTERNAL_API_BASE_URL: "https://internal.example/",
      VERCEL_ENV: "production",
      VERCEL_URL: "weather-abc.vercel.app",
      VERCEL_AUTOMATION_BYPASS_SECRET: "s3cret",
    });
    expect(target).toEqual({ base: "https://internal.example", headers: {} });
  });

  it("never uses the protected per-deployment host in production", () => {
    const target = internalApiTarget({
      VERCEL_ENV: "production",
      VERCEL_URL: "weather-abc.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL: "weather.mukoko.com",
    });
    expect(target.base).toBe("https://weather.mukoko.com");
    expect(target.base).not.toContain("weather-abc");
    expect(target.headers).toEqual({});
  });

  it("uses SITE_URL in production when the production URL is not exposed", () => {
    expect(
      internalApiTarget({
        VERCEL_ENV: "production",
        VERCEL_URL: "weather-abc.vercel.app",
      }).base,
    ).toBe(SITE_URL);
  });

  it("sends the protection bypass header to a preview's own host", () => {
    const target = internalApiTarget({
      VERCEL_ENV: "preview",
      VERCEL_URL: "weather-abc.vercel.app",
      VERCEL_AUTOMATION_BYPASS_SECRET: "s3cret",
    });
    expect(target).toEqual({
      base: "https://weather-abc.vercel.app",
      headers: { [PROTECTION_BYPASS_HEADER]: "s3cret" },
    });
    expect(PROTECTION_BYPASS_HEADER).toBe("x-vercel-protection-bypass");
  });

  it("sends no bypass header when the project has no bypass secret", () => {
    expect(
      internalApiTarget({
        VERCEL_ENV: "preview",
        VERCEL_URL: "weather-abc.vercel.app",
      }),
    ).toEqual({ base: "https://weather-abc.vercel.app", headers: {} });
  });

  it("internalApiBase is the base half of the target", () => {
    expect(
      internalApiBase({
        VERCEL_ENV: "production",
        VERCEL_PROJECT_PRODUCTION_URL: "weather.mukoko.com",
      }),
    ).toBe("https://weather.mukoko.com");
  });
});
