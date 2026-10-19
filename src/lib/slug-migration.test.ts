import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCATIONS } from "./locations";
import { buildSmartSlug, parseSmartSlug } from "./smart-slug";
import { haversineKm } from "./geo";
import { SEED_SLUG_TABLE } from "./slug-migration-data";
import {
  CANONICAL_TO_LEGACY,
  LEGACY_TO_CANONICAL,
  canonicalSlug,
  canonicalSlugList,
  canonicalSlugRecord,
  isCanonicalSeedSlug,
  isLegacySeedSlug,
  locationPath,
  migrateSlugPrefs,
  slugPrefsChanged,
  storageKeySlug,
} from "./slug-migration";
import {
  LOCATION_SLUG_RE,
  LOCATION_SUB_ROUTES,
  SEED_NAME_ALIASES,
  classifyLocationPath,
} from "./location-gate";

/**
 * The pinned legacy → canonical slug table (#317). To add rows for NEW seeds:
 *
 *   UPDATE_SLUG_MIGRATION=1 npx vitest run src/lib/slug-migration.test.ts
 *   node --experimental-strip-types workers/scripts/gen-seed-locations.mjs
 *   npx prettier@3.9.4 --write api/py/data/slug_migration.json
 *
 * Regeneration only ever APPENDS: an existing row is a URL that may already be
 * indexed, bookmarked or saved on a device, so it is never rewritten.
 */
const DATA_PATH = join(process.cwd(), "src/lib/slug-migration-data.ts");

const derived = LOCATIONS.map(
  (l) => [l.slug, buildSmartSlug(l.name, l.lat, l.lon)] as const,
);

if (process.env.UPDATE_SLUG_MIGRATION) {
  const rows = [...SEED_SLUG_TABLE];
  const have = new Set(rows.map(([legacy]) => legacy));
  for (const row of derived) if (!have.has(row[0])) rows.push(row);
  const header = `/**
 * The pinned legacy → canonical slug pair for every shipped seed place
 * (docs/canonical-slugs.md). Canonical is \`{slugified name}--{geohash7 of the
 * seed's coordinate}\`, derived ONCE and then pinned: a URL, once published,
 * never changes, so this table is append-only. A new seed needs a row; the
 * test fails until it has one and refuses a seed whose name or coordinate
 * would now derive a different slug than its pinned row.
 *
 * Add rows with \`UPDATE_SLUG_MIGRATION=1 npx vitest run
 * src/lib/slug-migration.test.ts\`, then regenerate the Python and Rust
 * copies with \`node --experimental-strip-types
 * workers/scripts/gen-seed-locations.mjs\`.
 */
export const SEED_SLUG_TABLE: readonly (readonly [string, string])[] = [
${rows.map(([a, b]) => `  [${JSON.stringify(a)}, ${JSON.stringify(b)}],`).join("\n")}
];
`;
  writeFileSync(DATA_PATH, header);
}

describe("the pinned slug table", () => {
  it("has exactly one row per shipped seed place", () => {
    const legacy = SEED_SLUG_TABLE.map(([l]) => l);
    expect(new Set(legacy).size).toBe(legacy.length);
    expect(new Set(legacy)).toEqual(new Set(LOCATIONS.map((l) => l.slug)));
  });

  it("is a bijection: no two places share a canonical slug", () => {
    const canonical = SEED_SLUG_TABLE.map(([, c]) => c);
    expect(new Set(canonical).size).toBe(canonical.length);
    expect(LEGACY_TO_CANONICAL.size).toBe(SEED_SLUG_TABLE.length);
    expect(CANONICAL_TO_LEGACY.size).toBe(SEED_SLUG_TABLE.length);
  });

  it("is deterministic: every row is {name}--{geohash7} of the seed itself", () => {
    // A seed whose name or coordinate changed would derive a different slug
    // than its pinned row. Fix the seed or accept the move on purpose.
    for (const [legacy, canonical] of derived) {
      expect(LEGACY_TO_CANONICAL.get(legacy), legacy).toBe(canonical);
    }
  });

  it("uses only well-formed smart slugs that decode back onto the seed", () => {
    for (const loc of LOCATIONS) {
      const canonical = LEGACY_TO_CANONICAL.get(loc.slug)!;
      expect(canonical).toMatch(LOCATION_SLUG_RE);
      expect(canonical).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*--[0-9b-hjkmnp-z]{7}$/);
      const parsed = parseSmartSlug(canonical);
      expect(parsed?.ref.kind).toBe("spot");
      // Within one 153 m cell of the seed's own coordinate.
      expect(
        haversineKm(loc.lat, loc.lon, parsed!.lat!, parsed!.lon!),
        canonical,
      ).toBeLessThan(0.2);
    }
  });

  it("never lets a canonical slug equal any legacy slug (no redirect can loop)", () => {
    const legacy = new Set(SEED_SLUG_TABLE.map(([l]) => l));
    for (const [, canonical] of SEED_SLUG_TABLE) {
      expect(legacy.has(canonical)).toBe(false);
      expect(canonicalSlug(canonical)).toBe(canonical);
    }
  });

  it("holds no verified OSM ref (the seed carries none)", () => {
    // The design note: an OSM ref is used only where we hold a verified one.
    for (const [, canonical] of SEED_SLUG_TABLE) {
      expect(canonical).not.toMatch(/--osm-/);
    }
  });
});

describe("slug helpers", () => {
  it("canonicalSlug and storageKeySlug are inverse on seeds and idempotent", () => {
    for (const [legacy, canonical] of SEED_SLUG_TABLE) {
      expect(canonicalSlug(legacy)).toBe(canonical);
      expect(canonicalSlug(canonical)).toBe(canonical);
      expect(storageKeySlug(canonical)).toBe(legacy);
      expect(storageKeySlug(legacy)).toBe(legacy);
      expect(isLegacySeedSlug(legacy)).toBe(true);
      expect(isCanonicalSeedSlug(canonical)).toBe(true);
    }
  });

  it("leaves every other slug alone", () => {
    for (const slug of [
      "west-paddock--ksy4dd7",
      "canberra-residences--osm-w890123",
      "harare-35c223",
      "not-a-seed",
      "",
    ]) {
      expect(canonicalSlug(slug)).toBe(slug);
      expect(storageKeySlug(slug)).toBe(slug);
    }
  });

  it("locationPath is always canonical, with an optional sub-route", () => {
    expect(locationPath("harare")).toBe(`/${canonicalSlug("harare")}`);
    expect(locationPath(canonicalSlug("harare"), "forecast")).toBe(
      `/${canonicalSlug("harare")}/forecast`,
    );
    expect(locationPath("west-paddock--ksy4dd7")).toBe(
      "/west-paddock--ksy4dd7",
    );
  });

  it("canonicalSlugList maps and drops the duplicate a mixed device holds", () => {
    const c = canonicalSlug("harare");
    expect(canonicalSlugList(["harare", "gweru", c])).toEqual([
      c,
      canonicalSlug("gweru"),
    ]);
    const once = canonicalSlugList(["harare", "x--ksy4dd7"]);
    expect(canonicalSlugList(once)).toEqual(once);
  });

  it("canonicalSlugRecord re-keys labels, a canonical key winning a clash", () => {
    const c = canonicalSlug("harare");
    expect(canonicalSlugRecord({ harare: "Home" })).toEqual({ [c]: "Home" });
    expect(canonicalSlugRecord({ harare: "old", [c]: "new" })).toEqual({
      [c]: "new",
    });
    expect(canonicalSlugRecord({ [c]: "new", harare: "old" })).toEqual({
      [c]: "new",
    });
  });
});

describe("saved-slug migration (store / RxDB / device sync)", () => {
  const legacyPrefs = {
    selectedLocation: "harare",
    savedLocations: ["bulawayo", "harare", "west-paddock--ksy4dd7"],
    homeLocation: "nairobi-ke",
    hiddenPresetSlugs: ["gweru"],
    locationLabels: { harare: "Home", "west-paddock--ksy4dd7": "Farm" },
    theme: "dark",
  };

  it("maps every slug field and nothing else", () => {
    const next = migrateSlugPrefs(legacyPrefs);
    expect(next).toEqual({
      selectedLocation: canonicalSlug("harare"),
      savedLocations: [
        canonicalSlug("bulawayo"),
        canonicalSlug("harare"),
        "west-paddock--ksy4dd7",
      ],
      homeLocation: canonicalSlug("nairobi-ke"),
      hiddenPresetSlugs: [canonicalSlug("gweru")],
      locationLabels: {
        [canonicalSlug("harare")]: "Home",
        "west-paddock--ksy4dd7": "Farm",
      },
      theme: "dark",
    });
    expect(slugPrefsChanged(legacyPrefs, next)).toBe(true);
  });

  it("is idempotent: a second pass changes nothing", () => {
    const once = migrateSlugPrefs(legacyPrefs);
    const twice = migrateSlugPrefs(once);
    expect(twice).toEqual(once);
    expect(slugPrefsChanged(once, twice)).toBe(false);
  });

  it("leaves absent and null fields alone", () => {
    expect(migrateSlugPrefs({})).toEqual({});
    expect(migrateSlugPrefs({ homeLocation: null })).toEqual({
      homeLocation: null,
    });
    expect(slugPrefsChanged({}, migrateSlugPrefs({}))).toBe(false);
  });

  it("dedupes a device that saved both spellings of one place", () => {
    const next = migrateSlugPrefs({
      savedLocations: ["harare", canonicalSlug("harare")],
    });
    expect(next.savedLocations).toEqual([canonicalSlug("harare")]);
  });
});

describe("every legacy URL redirects in one hop (308 target)", () => {
  const known = new Set(["explore", "api", "profile", "auth"]);

  it("sends every legacy seed slug, and each sub-route, to its canonical slug", () => {
    for (const [legacy, canonical] of SEED_SLUG_TABLE) {
      expect(classifyLocationPath(`/${legacy}`, known), legacy).toEqual({
        kind: "redirect",
        location: `/${canonical}`,
      });
      for (const sub of LOCATION_SUB_ROUTES) {
        expect(classifyLocationPath(`/${legacy}/${sub}`, known)).toEqual({
          kind: "redirect",
          location: `/${canonical}/${sub}`,
        });
      }
    }
  });

  it("lands on a location page: the target never redirects again", () => {
    for (const [, canonical] of SEED_SLUG_TABLE) {
      expect(classifyLocationPath(`/${canonical}`, known)).toEqual({
        kind: "slug",
        slug: canonical,
      });
      expect(classifyLocationPath(`/${canonical}/forecast`, known)).toEqual({
        kind: "slug",
        slug: canonical,
      });
    }
  });

  it("sends every bare seed name straight to the canonical slug, not via the legacy one", () => {
    expect(SEED_NAME_ALIASES.size).toBeGreaterThan(100);
    for (const [name, target] of SEED_NAME_ALIASES) {
      expect(isCanonicalSeedSlug(target), name).toBe(true);
      expect(classifyLocationPath(`/${name}`, known)).toEqual({
        kind: "redirect",
        location: `/${target}`,
      });
    }
  });

  it("redirects a legacy slug typed in the wrong case in the same single hop", () => {
    expect(classifyLocationPath("/Nairobi-KE/Map", known)).toEqual({
      kind: "redirect",
      location: `/${canonicalSlug("nairobi-ke")}/map`,
    });
  });
});

describe("generated copies for the other backends", () => {
  const read = (path: string) =>
    JSON.parse(readFileSync(join(process.cwd(), path), "utf8")) as {
      legacy: string;
      canonical: string;
    }[];
  const expected = SEED_SLUG_TABLE.map(([legacy, canonical]) => ({
    legacy,
    canonical,
  }));

  it("api/py/data/slug_migration.json matches the table", () => {
    expect(read("api/py/data/slug_migration.json")).toEqual(expected);
  });

  it("the Rust Workers' slug-migration.json matches the table", () => {
    expect(
      read("workers/crates/weather-core/data/slug-migration.json"),
    ).toEqual(expected);
  });
});
