/**
 * Tests for the current-location slug helper. The pure function is exercised
 * directly; the proxy.ts parity check reads the source so the two route lists
 * cannot silently diverge.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  NON_LOCATION_ROUTES,
  currentLocationSlug,
  displayNameFromSlug,
  isLocationSlug,
} from "./current-slug";

describe("currentLocationSlug", () => {
  it("uses the path segment on a location page", () => {
    expect(currentLocationSlug("/harare", "bulawayo")).toBe("harare");
  });

  it("takes only the FIRST segment on a sub-route", () => {
    expect(currentLocationSlug("/harare/forecast", "")).toBe("harare");
    expect(currentLocationSlug("/harare/atmosphere", null)).toBe("harare");
    expect(currentLocationSlug("/harare/map", undefined)).toBe("harare");
  });

  it("tolerates a trailing slash", () => {
    expect(currentLocationSlug("/harare/", "")).toBe("harare");
  });

  it("falls back to the store selection on the home page", () => {
    expect(currentLocationSlug("/", "bulawayo")).toBe("bulawayo");
  });

  it("falls back to the store selection on non-location routes", () => {
    expect(currentLocationSlug("/explore", "gweru")).toBe("gweru");
    expect(currentLocationSlug("/explore/country/zw", "gweru")).toBe("gweru");
    expect(currentLocationSlug("/history", "gweru")).toBe("gweru");
    expect(currentLocationSlug("/profile", "gweru")).toBe("gweru");
    expect(currentLocationSlug("/display", "gweru")).toBe("gweru");
  });

  it("returns null when the store is empty on the home page", () => {
    expect(currentLocationSlug("/", "")).toBeNull();
    expect(currentLocationSlug("/", null)).toBeNull();
  });

  it("never falls back to the literal 'harare'", () => {
    expect(currentLocationSlug("/", "")).not.toBe("harare");
    expect(currentLocationSlug("/explore", undefined)).toBeNull();
  });

  it("accepts smart slugs containing the -- delimiter", () => {
    expect(currentLocationSlug("/harare--ksy4dd7/forecast", "")).toBe(
      "harare--ksy4dd7",
    );
  });

  it("never returns a value containing a slash", () => {
    const cases: Array<[string, string]> = [
      ["/harare/forecast", "x/y"],
      ["/", "a/b"],
      ["//harare", ""],
    ];
    for (const [path, sel] of cases) {
      const slug = currentLocationSlug(path, sel);
      if (slug) expect(slug).not.toContain("/");
    }
  });

  it("rejects an invalid selection rather than writing it through", () => {
    expect(currentLocationSlug("/", "Harare Town")).toBeNull();
    expect(currentLocationSlug("/", "explore")).toBeNull();
  });
});

describe("isLocationSlug", () => {
  it("accepts lowercase slugs with digits and hyphens", () => {
    expect(isLocationSlug("nairobi-ke")).toBe(true);
    expect(isLocationSlug("harare")).toBe(true);
    expect(isLocationSlug("harare--ksy4dd7")).toBe(true);
  });

  it("rejects empty, uppercase, slashed, and over-long values", () => {
    expect(isLocationSlug("")).toBe(false);
    expect(isLocationSlug("Harare")).toBe(false);
    expect(isLocationSlug("harare/forecast")).toBe(false);
    expect(isLocationSlug("a".repeat(81))).toBe(false);
    expect(isLocationSlug(undefined)).toBe(false);
  });

  it("rejects known app routes", () => {
    expect(isLocationSlug("explore")).toBe(false);
    expect(isLocationSlug("callback")).toBe(false);
  });
});

describe("NON_LOCATION_ROUTES parity with src/proxy.ts", () => {
  it("contains every KNOWN_ROUTES entry from the edge proxy", () => {
    const proxySource = readFileSync(
      resolve(__dirname, "../proxy.ts"),
      "utf-8",
    );
    const block = proxySource.match(
      /const KNOWN_ROUTES = new Set\(\[([\s\S]*?)\]\);/,
    );
    expect(block).not.toBeNull();
    const entries = [...block![1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
    expect(entries.length).toBeGreaterThan(0);
    for (const route of entries) {
      expect(NON_LOCATION_ROUTES.has(route)).toBe(true);
    }
  });
});

describe("displayNameFromSlug", () => {
  it("strips a trailing platform hash segment", () => {
    expect(displayNameFromSlug("bulawayo-e7b1f4")).toBe("Bulawayo");
    expect(displayNameFromSlug("nairobi-518dd4")).toBe("Nairobi");
  });

  it("keeps the name before a smart-slug delimiter", () => {
    expect(displayNameFromSlug("harare--ksy4dd7")).toBe("Harare");
  });

  it("leaves plain legacy slugs readable", () => {
    expect(displayNameFromSlug("harare")).toBe("Harare");
    expect(displayNameFromSlug("nairobi-ke")).toBe("Nairobi KE");
  });

  it("does not strip non-hex suffixes", () => {
    expect(displayNameFromSlug("kwekwe-zzzzzz")).toBe("Kwekwe Zzzzzz");
  });
});
