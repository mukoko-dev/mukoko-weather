import { describe, it, expect } from "vitest";
import { SITE_URL } from "./site";

describe("SITE_URL", () => {
  it("is the canonical production origin with no trailing slash", () => {
    expect(SITE_URL).toBe("https://weather.mukoko.com");
  });
});

describe("no server-to-self calls", () => {
  it("has no internal API target: the Python functions it reached are gone", async () => {
    const site = await import("./site");
    expect(Object.keys(site)).toEqual(["SITE_URL"]);
  });
});
