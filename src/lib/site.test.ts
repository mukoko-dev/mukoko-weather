import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SITE_URL, internalApiBase } from "./site";

describe("SITE_URL", () => {
  it("is the canonical production origin with no trailing slash", () => {
    expect(SITE_URL).toBe("https://weather.mukoko.com");
  });
});

describe("internalApiBase", () => {
  const saved = {
    VERCEL_URL: process.env.VERCEL_URL,
    INTERNAL_API_BASE_URL: process.env.INTERNAL_API_BASE_URL,
  };

  beforeEach(() => {
    delete process.env.VERCEL_URL;
    delete process.env.INTERNAL_API_BASE_URL;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("falls back to localhost when nothing is configured", () => {
    expect(internalApiBase()).toBe("http://localhost:3000");
  });

  it("uses INTERNAL_API_BASE_URL when set", () => {
    process.env.INTERNAL_API_BASE_URL = "https://internal.example";
    expect(internalApiBase()).toBe("https://internal.example");
  });

  it("prefers VERCEL_URL over INTERNAL_API_BASE_URL", () => {
    process.env.VERCEL_URL = "weather-abc.vercel.app";
    process.env.INTERNAL_API_BASE_URL = "https://internal.example";
    expect(internalApiBase()).toBe("https://weather-abc.vercel.app");
  });
});
