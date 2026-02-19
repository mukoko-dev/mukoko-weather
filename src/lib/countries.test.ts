import { describe, it, expect } from "vitest";
import { getFlagEmoji, generateProvinceSlug, COUNTRIES, PROVINCES } from "./countries";

describe("getFlagEmoji", () => {
  it("returns correct flag emoji for Zimbabwe", () => {
    expect(getFlagEmoji("ZW")).toBe("🇿🇼");
  });

  it("returns correct flag emoji for Kenya", () => {
    expect(getFlagEmoji("KE")).toBe("🇰🇪");
  });

  it("returns correct flag emoji for South Africa", () => {
    expect(getFlagEmoji("ZA")).toBe("🇿🇦");
  });

  it("works with lowercase input", () => {
    expect(getFlagEmoji("ng")).toBe("🇳🇬");
  });

  it("returns a 2-character regional indicator sequence", () => {
    const flag = getFlagEmoji("TZ");
    // Each regional indicator is a 2-byte surrogate pair → 4 JS chars per letter
    expect([...flag].length).toBe(2);
  });
});

describe("generateProvinceSlug", () => {
  it("lowercases and dasherises province name", () => {
    expect(generateProvinceSlug("Mashonaland West", "ZW")).toBe("mashonaland-west-zw");
  });

  it("lowercases the country code suffix", () => {
    expect(generateProvinceSlug("Nairobi County", "KE")).toBe("nairobi-county-ke");
  });

  it("strips diacritics", () => {
    expect(generateProvinceSlug("Zambézia Province", "MZ")).toBe("zambezia-province-mz");
  });

  it("strips apostrophes and special chars", () => {
    expect(generateProvinceSlug("KwaZulu-Natal", "ZA")).toBe("kwazulu-natal-za");
  });

  it("collapses multiple dashes", () => {
    expect(generateProvinceSlug("North--East Region", "BW")).toBe("north--east-region-bw".replace("--", "-"));
  });
});

describe("COUNTRIES seed data", () => {
  it("contains at least 60 entries", () => {
    expect(COUNTRIES.length).toBeGreaterThanOrEqual(60);
  });

  it("includes Zimbabwe with correct region", () => {
    const zw = COUNTRIES.find((c) => c.code === "ZW");
    expect(zw).toBeDefined();
    expect(zw?.region).toBe("Southern Africa");
    expect(zw?.name).toBe("Zimbabwe");
  });

  it("includes all 11 ASEAN/Pacific nations (including Timor-Leste)", () => {
    const asean = ["BN", "ID", "KH", "LA", "MM", "MY", "PH", "SG", "TH", "TL", "VN"];
    for (const code of asean) {
      const found = COUNTRIES.find((c) => c.code === code);
      expect(found, `Missing ASEAN country ${code}`).toBeDefined();
    }
  });

  it("every country has a non-empty code, name, and region", () => {
    for (const c of COUNTRIES) {
      expect(c.code.length).toBe(2);
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.region.length).toBeGreaterThan(0);
    }
  });

  it("country codes are unique", () => {
    const codes = COUNTRIES.map((c) => c.code);
    const unique = new Set(codes);
    expect(unique.size).toBe(codes.length);
  });

  it("all countries are marked as supported", () => {
    expect(COUNTRIES.every((c) => c.supported)).toBe(true);
  });
});

describe("PROVINCES seed data", () => {
  it("contains at least 10 Zimbabwe provinces", () => {
    const zwProvinces = PROVINCES.filter((p) => p.countryCode === "ZW");
    expect(zwProvinces.length).toBe(10);
  });

  it("province slugs are unique", () => {
    const slugs = PROVINCES.map((p) => p.slug);
    const unique = new Set(slugs);
    expect(unique.size).toBe(slugs.length);
  });

  it("every province has slug, name, and countryCode", () => {
    for (const p of PROVINCES) {
      expect(p.slug.length).toBeGreaterThan(0);
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.countryCode.length).toBe(2);
    }
  });

  it("province slugs end with the lowercase countryCode", () => {
    for (const p of PROVINCES) {
      expect(p.slug.endsWith(`-${p.countryCode.toLowerCase()}`)).toBe(true);
    }
  });

  it("includes Harare province for Zimbabwe", () => {
    const harare = PROVINCES.find((p) => p.slug === "harare-zw");
    expect(harare).toBeDefined();
    expect(harare?.countryCode).toBe("ZW");
  });
});
