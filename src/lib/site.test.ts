import { describe, it, expect } from "vitest";
import { SITE_URL, PROTECTION_BYPASS_HEADER, internalApiTarget } from "./site";

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

  it("production without a bypass secret uses the public origin, never the protected host", () => {
    const target = internalApiTarget({
      VERCEL_ENV: "production",
      VERCEL_URL: "weather-abc.vercel.app",
    });
    expect(target).toEqual({ base: SITE_URL, headers: {} });
  });

  it("production uses the public origin even when a bypass secret is injected", () => {
    expect(
      internalApiTarget({
        VERCEL_ENV: "production",
        VERCEL_URL: "weather-abc.vercel.app",
        VERCEL_AUTOMATION_BYPASS_SECRET: "s3cret",
      }),
    ).toEqual({ base: SITE_URL, headers: {} });
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
});
