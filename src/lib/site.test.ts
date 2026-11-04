import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, it, expect } from "vitest";
import { SITE_URL } from "./site";

describe("SITE_URL", () => {
  it("is the canonical production origin with no trailing slash", () => {
    expect(SITE_URL).toBe("https://weather.mukoko.com");
  });
});

describe("no server-to-self calls", () => {
  it("has no internal API target: the Python functions it reached are gone", () => {
    const source = readFileSync(resolve(__dirname, "site.ts"), "utf-8");
    // `internalApiTarget` read these to fetch our own /api/py functions.
    for (const gone of [
      "internalApiTarget",
      "INTERNAL_API_BASE_URL",
      "VERCEL_URL",
      "VERCEL_AUTOMATION_BYPASS_SECRET",
      "x-vercel-protection-bypass",
      "process.env",
    ]) {
      expect(source).not.toContain(gone);
    }
  });
});
