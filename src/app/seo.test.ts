import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import robots from "./robots";
import sitemap from "./sitemap";

describe("robots.ts", () => {
  const result = robots();

  it("allows all user agents", () => {
    expect(result.rules).toBeDefined();
    const rules = Array.isArray(result.rules) ? result.rules : [result.rules];
    expect(rules[0].userAgent).toBe("*");
  });

  it("allows root path and llms.txt files", () => {
    const rules = Array.isArray(result.rules) ? result.rules : [result.rules];
    const allowed = rules[0].allow;
    expect(allowed).toContain("/");
    expect(allowed).toContain("/llms.txt");
    expect(allowed).toContain("/llms-full.txt");
  });

  it("disallows /api/ and /embed/", () => {
    const rules = Array.isArray(result.rules) ? result.rules : [result.rules];
    const disallowed = rules[0].disallow;
    expect(disallowed).toContain("/api/");
    expect(disallowed).toContain("/embed/");
  });

  it("includes sitemap URL", () => {
    expect(result.sitemap).toBe("https://weather.mukoko.com/sitemap.xml");
  });

  it("includes host", () => {
    expect(result.host).toBe("https://weather.mukoko.com");
  });
});

describe("sitemap.ts", () => {
  // Sitemap now queries MongoDB — in tests without a DB, it returns
  // static pages + explore tag pages (locations array will be empty).
  it("includes the homepage", async () => {
    const result = await sitemap();
    const home = result.find((entry) => entry.url === "https://weather.mukoko.com");
    expect(home).toBeDefined();
    expect(home!.priority).toBe(1.0);
    expect(home!.changeFrequency).toBe("hourly");
  });

  it("includes static pages (about, help, history, privacy, terms)", async () => {
    const result = await sitemap();

    const aboutEntry = result.find((e) => e.url === "https://weather.mukoko.com/about");
    expect(aboutEntry).toBeDefined();
    expect(aboutEntry!.changeFrequency).toBe("monthly");

    const helpEntry = result.find((e) => e.url === "https://weather.mukoko.com/help");
    expect(helpEntry).toBeDefined();
    expect(helpEntry!.changeFrequency).toBe("monthly");

    const historyEntry = result.find((e) => e.url === "https://weather.mukoko.com/history");
    expect(historyEntry).toBeDefined();
    expect(historyEntry!.changeFrequency).toBe("daily");
    expect(historyEntry!.priority).toBe(0.8);

    const privacyEntry = result.find((e) => e.url === "https://weather.mukoko.com/privacy");
    expect(privacyEntry).toBeDefined();
    expect(privacyEntry!.changeFrequency).toBe("yearly");

    const termsEntry = result.find((e) => e.url === "https://weather.mukoko.com/terms");
    expect(termsEntry).toBeDefined();
    expect(termsEntry!.changeFrequency).toBe("yearly");
  });

  it("includes explore page and tag pages", async () => {
    const result = await sitemap();
    const explore = result.find((e) => e.url === "https://weather.mukoko.com/explore");
    expect(explore).toBeDefined();
    expect(explore!.priority).toBe(0.8);

    const exploreTags = ["city", "farming", "mining", "tourism", "national-park", "education", "border", "travel"];
    for (const tag of exploreTags) {
      const entry = result.find((e) => e.url === `https://weather.mukoko.com/explore/${tag}`);
      expect(entry).toBeDefined();
      expect(entry!.priority).toBe(0.7);
    }
  });

  it("includes boosted city entries (harare, bulawayo, victoria-falls)", async () => {
    const result = await sitemap();
    const harare = result.find((e) => e.url === "https://weather.mukoko.com/harare");
    expect(harare).toBeDefined();
    expect(harare!.priority).toBe(0.9);

    const bulawayo = result.find((e) => e.url === "https://weather.mukoko.com/bulawayo");
    expect(bulawayo).toBeDefined();
    expect(bulawayo!.priority).toBe(0.9);

    const vicfalls = result.find((e) => e.url === "https://weather.mukoko.com/victoria-falls");
    expect(vicfalls).toBeDefined();
    expect(vicfalls!.priority).toBe(0.9);
  });

  it("at minimum includes static pages + explore tag pages (12 + 8 = 20)", async () => {
    const result = await sitemap();
    // Without MongoDB, we get 12 static + 8 explore tags = 20 minimum
    // With MongoDB, we also get location pages + sub-routes
    expect(result.length).toBeGreaterThanOrEqual(20);
  });

  it("all entries have lastModified set", async () => {
    const result = await sitemap();
    for (const entry of result) {
      expect(entry.lastModified).toBeDefined();
      expect(entry.lastModified).toBeInstanceOf(Date);
    }
  });

  it("all URLs use https", async () => {
    const result = await sitemap();
    for (const entry of result) {
      expect(entry.url).toMatch(/^https:\/\//);
    }
  });
});

describe("country-aware metadata in [location]/page.tsx", () => {
  const pageSource = readFileSync(
    resolve(__dirname, "[location]/page.tsx"),
    "utf-8",
  );

  it("imports getCountryByCode from db lib for country names", () => {
    expect(pageSource).toContain("getCountryByCode");
    expect(pageSource).toContain("@/lib/db");
  });

  it("derives countryCode from loc.country with ZW fallback", () => {
    expect(pageSource).toContain('loc.country ?? "ZW"');
  });

  it("uses countryName variable in metadata description", () => {
    expect(pageSource).toContain("countryName");
    expect(pageSource).toContain("countryCode");
  });

  it("uses addressCountry in JSON-LD schema", () => {
    expect(pageSource).toContain("addressCountry");
  });

  it("uses countryCode for addressCountry in JSON-LD", () => {
    // addressCountry should use the actual ISO code, not hardcoded "ZW"
    const addressCountrySection = pageSource.slice(
      pageSource.indexOf("addressCountry"),
      pageSource.indexOf("addressCountry") + 50,
    );
    expect(addressCountrySection).toContain("countryCode");
  });

  it("containedInPlace uses dynamic country name in JSON-LD", () => {
    expect(pageSource).toContain("containedInPlace");
    expect(pageSource).toContain("countryName");
  });

  it("has generateMetadata function for per-page SEO", () => {
    expect(pageSource).toContain("generateMetadata");
  });
});

describe("[location]/page.tsx — breadcrumb and JSON-LD schemas", () => {
  const pageSource = readFileSync(
    resolve(__dirname, "[location]/page.tsx"),
    "utf-8",
  );

  it("exports BreadcrumbList JSON-LD schema", () => {
    expect(pageSource).toContain("BreadcrumbList");
  });

  it("exports Place/WebPage JSON-LD schema with geo coordinates", () => {
    expect(pageSource).toContain("GeoCoordinates");
    expect(pageSource).toContain("location.lat");
  });

  it("exports FAQPage schema with location-specific questions", () => {
    expect(pageSource).toContain("FAQPage");
    expect(pageSource).toContain("Question");
  });
});
