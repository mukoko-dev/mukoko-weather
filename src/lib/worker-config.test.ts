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

  it("the public API's anonymous per-IP limit is 600 a minute (shared networks), the developer-key limit unchanged", () => {
    const text = wrangler("public-api");
    const limit = (name: string) =>
      Number(
        text.match(
          new RegExp(
            `"name":\\s*"${name}",[^}]*?"simple":\\s*\\{\\s*"limit":\\s*(\\d+),\\s*"period":\\s*(\\d+)`,
            "s",
          ),
        )?.[1],
      );
    // A school or office network shares one IP; the upstream cost is bounded
    // by the KV caches and the D1 budgets, not by this limiter (#414).
    expect(limit("RATE_LIMITER")).toBe(600);
    expect(limit("KEY_RATE_LIMITER")).toBe(600);
    expect(text).toMatch(/shared network|school/i);
  });

  it("the service worker does not reload the page whenever the browser comes back online", () => {
    const config = readFileSync(
      resolve(__dirname, "../../next.config.ts"),
      "utf-8",
    );
    // @serwist/next injects `window.addEventListener("online", () =>
    // location.reload())` by default, which restarts the app on every
    // reconnect (#414). It must be switched off explicitly.
    expect(config).toMatch(/reloadOnOnline:\s*false/);
  });
});

describe("weather stations already in the field (the old upload URL)", () => {
  const ROOT = resolve(__dirname, "../..");
  const vercel = JSON.parse(
    readFileSync(resolve(ROOT, "vercel.json"), "utf-8"),
  ) as {
    rewrites: { source: string; destination: string }[];
    functions?: unknown;
    builds?: unknown;
  };
  const rewrites = vercel.rewrites;

  it("vercel.json sends the old ingest path to the stations Worker, and nothing else under /api/py", () => {
    // The Python backend is gone: no catch-all rewrite to a Python function, so
    // every other /api/py/* path is an ordinary 404 from Next.js.
    expect(rewrites.map((r) => r.source)).toEqual(["/api/py/stations/ingest"]);
    expect(rewrites.some((r) => r.source === "/api/py/(.*)")).toBe(false);
    // The Worker serves the same path (it strips `/api/py`), so a console
    // configured with the old URL keeps the protocol it speaks.
    expect(rewrites[0]!.destination).toBe(
      "https://weather-ingest.nyuchi.com/api/py/stations/ingest",
    );
  });

  it("vercel.json builds no Python function", () => {
    expect(vercel.functions).toBeUndefined();
    expect(vercel.builds).toBeUndefined();
    expect(JSON.stringify(vercel)).not.toMatch(
      /python|\.py\b|@vercel\/python/i,
    );
  });

  it("the stations Worker also takes weather.mukoko.com/api/py/stations/* as a route", () => {
    const text = wrangler("stations");
    expect(text).toMatch(
      /"pattern":\s*"weather\.mukoko\.com\/api\/py\/stations\/\*",\s*"zone_name":\s*"mukoko\.com"/,
    );
    // The custom domain the consoles are told to use stays.
    expect(text).toMatch(
      /"pattern":\s*"weather-ingest\.nyuchi\.com",\s*"custom_domain":\s*true/,
    );
  });
});
