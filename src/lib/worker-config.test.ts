/**
 * Facts about the Worker configs the app depends on, pinned so a change to
 * either side fails here instead of in production.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

const WORKERS = resolve(__dirname, "../../workers");

function wrangler(dir: string): string {
  return readFileSync(resolve(WORKERS, dir, "wrangler.jsonc"), "utf-8");
}

describe("weather Worker config", () => {
  it("the public API allows the app's origin through CORS (browser calls the Worker directly)", () => {
    const m = wrangler("public-api").match(/"CORS_ORIGINS":\s*"([^"]+)"/);
    const origins = (m?.[1] ?? "").split(",");
    expect(origins).toContain("https://weather.mukoko.com");
    expect(origins).not.toContain("*");
  });

  it("the app's CSP lets the browser connect to the Worker origin", () => {
    const csp = readFileSync(
      resolve(__dirname, "security-headers.ts"),
      "utf-8",
    );
    expect(csp).toContain("https://weather-api.mukoko.com");
  });

  it("every rate-limit namespace id is used once across all Workers", () => {
    const seen = new Map<string, string>();
    for (const dir of readdirSync(WORKERS, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      let text: string;
      try {
        text = wrangler(dir.name);
      } catch {
        continue;
      }
      for (const m of text.matchAll(
        /"name":\s*"([A-Z_]+)",\s*"namespace_id":\s*"(\d+)"/g,
      )) {
        const [, name, id] = m;
        expect(
          seen.get(id),
          `namespace_id ${id} is used by ${seen.get(id)} and ${dir.name}/${name}`,
        ).toBeUndefined();
        seen.set(id, `${dir.name}/${name}`);
      }
    }
    expect(seen.size).toBeGreaterThan(2);
  });

  it("the places Worker keeps its hourly geocoder budgets in D1, not in extra limiter bindings", () => {
    const text = wrangler("places");
    expect(text).not.toMatch(/GEOCODE_FWD/);
    // Hourly budgets live in D1 (weather_core::budget), not in bindings.
    expect(text).toContain("rate_events");
  });
});
