import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCATIONS } from "./locations";

/**
 * `api/py/data/seed_locations.json` is the Python backend's copy of the
 * static seed catalogue (#302): the search fallback for a country with no
 * stored places and the find-only geo fallback read it. This test pins it to
 * `src/lib/locations.ts`. To regenerate after editing the seed:
 *
 *   UPDATE_SEED_JSON=1 npx vitest run src/lib/seed-catalogue-parity.test.ts
 *   npx prettier@3.9.4 --write api/py/data/seed_locations.json
 */
const JSON_PATH = join(process.cwd(), "api/py/data/seed_locations.json");

const expected = LOCATIONS.map((l) => ({
  slug: l.slug,
  name: l.name,
  country: l.country ?? "",
  province: l.province,
  lat: l.lat,
  lon: l.lon,
  elevation: l.elevation,
  tags: l.tags,
}));

if (process.env.UPDATE_SEED_JSON) {
  writeFileSync(JSON_PATH, JSON.stringify(expected, null, 2) + "\n");
}

describe("Python seed catalogue JSON", () => {
  const actual = JSON.parse(readFileSync(JSON_PATH, "utf8")) as typeof expected;

  it("matches src/lib/locations.ts exactly", () => {
    expect(actual).toEqual(expected);
  });

  it("carries every seed slug once, each with a country", () => {
    const slugs = actual.map((l) => l.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(actual.every((l) => /^[A-Z]{2}$/.test(l.country))).toBe(true);
    expect(slugs).toContain("phuket-th");
    expect(slugs).toContain("bangkok-th");
  });
});
