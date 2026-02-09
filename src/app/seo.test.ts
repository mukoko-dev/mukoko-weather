import { describe, it, expect } from "vitest";
import { LOCATIONS } from "@/lib/locations";
import robots from "./robots";
import sitemap from "./sitemap";

describe("robots.ts", () => {
  const result = robots();

  it("allows all user agents", () => {
    expect(result.rules).toBeDefined();
    const rules = Array.isArray(result.rules) ? result.rules : [result.rules];
    expect(rules[0].userAgent).toBe("*");
  });

  it("allows root path", () => {
    const rules = Array.isArray(result.rules) ? result.rules : [result.rules];
    expect(rules[0].allow).toBe("/");
  });

  it("disallows /api/ and /embed/", () => {
    const rules = Array.isArray(result.rules) ? result.rules : [result.rules];
    const disallowed = rules[0].disallow;
    expect(disallowed).toContain("/api/");
    expect(disallowed).toContain("/embed/");
  });

  it("includes sitemap URL", () => {
    expect(result.sitemap).toBe("https://weather.mukoko.africa/sitemap.xml");
  });

  it("includes host", () => {
    expect(result.host).toBe("https://weather.mukoko.africa");
  });
});

describe("sitemap.ts", () => {
  const result = sitemap();

  it("includes the homepage", () => {
    const home = result.find((entry) => entry.url === "https://weather.mukoko.africa");
    expect(home).toBeDefined();
    expect(home!.priority).toBe(1.0);
    expect(home!.changeFrequency).toBe("hourly");
  });

  it("includes all locations from the database", () => {
    for (const loc of LOCATIONS) {
      const entry = result.find((e) => e.url === `https://weather.mukoko.africa/${loc.slug}`);
      expect(entry).toBeDefined();
    }
  });

  it("total entries = 1 (home) + all locations", () => {
    expect(result.length).toBe(1 + LOCATIONS.length);
  });

  it("city locations have priority 0.9", () => {
    const harare = result.find((e) => e.url === "https://weather.mukoko.africa/harare");
    expect(harare).toBeDefined();
    expect(harare!.priority).toBe(0.9);
  });

  it("non-city locations have priority 0.7", () => {
    const mazowe = result.find((e) => e.url === "https://weather.mukoko.africa/mazowe");
    expect(mazowe).toBeDefined();
    expect(mazowe!.priority).toBe(0.7);
  });

  it("all entries have changeFrequency set to hourly", () => {
    for (const entry of result) {
      expect(entry.changeFrequency).toBe("hourly");
    }
  });

  it("all entries have lastModified set", () => {
    for (const entry of result) {
      expect(entry.lastModified).toBeDefined();
      expect(entry.lastModified).toBeInstanceOf(Date);
    }
  });

  it("all URLs use https", () => {
    for (const entry of result) {
      expect(entry.url).toMatch(/^https:\/\//);
    }
  });
});
