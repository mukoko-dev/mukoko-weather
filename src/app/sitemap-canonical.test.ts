/**
 * The sitemap lists the CANONICAL URL of every shipped place and its
 * sub-routes, and leaves a non-seed place's slug alone (#317).
 *
 * `seo.test.ts` runs the sitemap without a database, so no per-location page
 * is listed there; this file feeds it real locations and checks the mapping.
 */
import { describe, expect, it, vi } from "vitest";
import { canonicalSlug } from "@/lib/slug-migration";
import { SEED_SLUG_TABLE } from "@/lib/slug-migration-data";

const rows = vi.hoisted(() => ({
  locations: [] as { slug: string; tags: string[] }[],
}));

vi.mock("@/lib/db", () => ({
  getAllLocationSlugsForSitemap: async () => rows.locations,
  getAllCountryCodes: async () => ["ZW"],
  getAllProvinces: async () => [],
  getFeaturedTagsFromDb: async () => [],
}));

const { default: sitemap } = await import("./sitemap");

const BASE = "https://weather.mukoko.com";
const SUBS = ["forecast", "atmosphere", "map", "agriculture"];

describe("sitemap: per-location pages", () => {
  it("lists every shipped place and its sub-routes under the canonical slug, never the legacy one", async () => {
    rows.locations = SEED_SLUG_TABLE.map(([legacy]) => ({
      slug: legacy,
      tags: ["city", "farming"],
    }));
    const urls = new Set((await sitemap()).map((e) => e.url));

    for (const [legacy, canonical] of SEED_SLUG_TABLE) {
      expect(urls.has(`${BASE}/${canonical}`), canonical).toBe(true);
      for (const sub of SUBS) {
        expect(urls.has(`${BASE}/${canonical}/${sub}`), canonical).toBe(true);
        expect(urls.has(`${BASE}/${legacy}/${sub}`), legacy).toBe(false);
      }
      expect(urls.has(`${BASE}/${legacy}`), legacy).toBe(false);
    }
  });

  it("leaves a place that is not in the pinned table under its own slug", async () => {
    rows.locations = [
      { slug: "kakamega-ke", tags: ["city"] },
      { slug: "harare-35c223", tags: ["city"] },
      { slug: "west-paddock--ksy4dd7", tags: [] },
    ];
    const urls = new Set((await sitemap()).map((e) => e.url));
    for (const slug of [
      "kakamega-ke",
      "harare-35c223",
      "west-paddock--ksy4dd7",
    ]) {
      expect(canonicalSlug(slug)).toBe(slug);
      expect(urls.has(`${BASE}/${slug}`), slug).toBe(true);
      expect(urls.has(`${BASE}/${slug}/forecast`), slug).toBe(true);
    }
  });

  it("lists no location URL twice", async () => {
    rows.locations = SEED_SLUG_TABLE.map(([legacy]) => ({
      slug: legacy,
      tags: ["city"],
    }));
    const urls = (await sitemap()).map((e) => e.url);
    expect(new Set(urls).size).toBe(urls.length);
  });
});
