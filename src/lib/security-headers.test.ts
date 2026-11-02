import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import nextConfig from "../../next.config";
import {
  buildCsp,
  CORS_POLICY,
  CSP_DIRECTIVES,
  PERMISSIONS_POLICY,
} from "./security-headers";

type Rule = { source: string; headers: { key: string; value: string }[] };
const rules = (await (
  nextConfig as { headers: () => Promise<Rule[]> }
).headers()) as Rule[];
const rule = (source: string) => rules.filter((r) => r.source === source);
const hdr = (r: Rule[], key: string) =>
  r.flatMap((x) => x.headers).find((h) => h.key === key)?.value;

describe("security headers (B05)", () => {
  const all = rule("/:path*");
  it("sets the baseline on every path", () => {
    expect(hdr(all, "Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(hdr(all, "X-Content-Type-Options")).toBe("nosniff");
    const pp = hdr(all, "Permissions-Policy")!;
    expect(pp).toContain("geolocation=(self)");
    expect(pp).toContain("camera=()");
    expect(pp).toContain("microphone=()");
  });

  it("frames same-origin only, but excludes embed and display", () => {
    const r = rules.find((x) =>
      x.headers.some((h) => h.key === "X-Frame-Options"),
    )!;
    expect(r.headers[0].value).toBe("SAMEORIGIN");
    const re = new RegExp(`^${r.source.replace(/^\//, "\\/")}$`);
    expect(re.test("/harare")).toBe(true);
    expect(re.test("/embed/widget")).toBe(false);
    expect(re.test("/display")).toBe(false);
    expect(re.test("/displaced-farm--ksy4dd7")).toBe(true);
  });

  it("keeps the embed widget frameable anywhere", () => {
    expect(hdr(rule("/embed/widget"), "Content-Security-Policy")).toBe(
      "frame-ancestors *",
    );
  });

  it("ships CSP as report-only and never enforces a policy on pages", () => {
    const r = rules.find((x) =>
      x.headers.some((h) => h.key === "Content-Security-Policy-Report-Only"),
    )!;
    expect(r.headers).toHaveLength(1);
    expect(
      rules
        .filter((x) => x !== r && x.source !== "/embed/widget")
        .flatMap((x) => x.headers)
        .some((h) => h.key === "Content-Security-Policy"),
    ).toBe(false);
    expect(r.headers[0].value).toContain("report-uri /api/csp-report");
  });

  it("allowlists the third parties the app uses", () => {
    const csp = buildCsp();
    for (const host of [
      "https://www.googletagmanager.com",
      "https://va.vercel-scripts.com",
      "https://api.maptiler.com",
      "https://api.open-meteo.com",
      "https://weather-api.mukoko.com",
      "https://weather-tiles.mukoko.com",
      "https://api.workos.com",
      "https://avatars.githubusercontent.com",
      "https://www.google.com",
    ])
      expect(csp).toContain(host);
    expect(CSP_DIRECTIVES["worker-src"]).toContain("blob:");
    expect(CSP_DIRECTIVES["img-src"]).toEqual(
      expect.arrayContaining(["data:", "blob:"]),
    );
    expect(CSP_DIRECTIVES["object-src"]).toEqual(["'none'"]);
  });

  it("lets the map load overlay tiles from the tiles Worker", () => {
    for (const directive of ["img-src", "connect-src"] as const)
      expect(CSP_DIRECTIVES[directive]).toContain(
        "https://weather-tiles.mukoko.com",
      );
  });

  it("lets the flagged CouchDB sync reach the Nyuchi API, and only connect-src", () => {
    expect(CSP_DIRECTIVES["connect-src"]).toContain("https://api.nyuchi.com");
    for (const directive of Object.keys(CSP_DIRECTIVES)) {
      if (directive === "connect-src") continue;
      expect(
        (CSP_DIRECTIVES as Record<string, string[]>)[directive],
        directive,
      ).not.toContain("https://api.nyuchi.com");
    }
  });

  it("allows no Google Fonts origin (fonts are self-hosted via next/font)", () => {
    const csp = buildCsp();
    expect(csp).not.toContain("fonts.googleapis.com");
    expect(csp).not.toContain("fonts.gstatic.com");
  });
});

describe("CORS (B06)", () => {
  const wildcard = rules.filter((r) =>
    r.headers.some(
      (h) => h.key === "Access-Control-Allow-Origin" && h.value === "*",
    ),
  );
  const sources = wildcard.map((r) => r.source).sort();

  it("keeps the embeds CORS-open", () => {
    for (const s of ["/api/embed/:path*", "/embed/:path*"])
      expect(sources).toContain(s);
  });

  it("the API Worker opens exactly the documented routes", () => {
    // `weather_core::cors::OPEN_READ_ROUTES` is the Worker's own open list: the
    // routes that replace the open Python ones (weather and air quality, + its
    // grid) and the two that already moved (geo, search).
    const rust = readFileSync(
      resolve(__dirname, "../../workers/crates/weather-core/src/cors.rs"),
      "utf-8",
    );
    // Tolerates the array type being sized or a slice, and the list being one
    // line or one entry per line.
    const block = /pub const OPEN_READ_ROUTES[^=]*=\s*&?\[([^\]]*)\]/.exec(
      rust,
    );
    expect(block).not.toBeNull();
    const workerRoutes = [...(block?.[1] ?? "").matchAll(/"([^"]+)"/g)]
      .map((m) => m[1])
      .sort();
    expect(workerRoutes).toEqual(
      [
        "/v1/air-quality",
        "/v1/air-quality/grid",
        "/v1/geo",
        "/v1/search",
        "/v1/weather",
      ].sort(),
    );
  });

  it("opens nothing under /api/py: the Python routes are gone", () => {
    // The public read API moved to the Worker (/v1/weather, /v1/air-quality,
    // /v1/geo, /v1/search), whose open routes are
    // `weather_core::cors::OPEN_READ_ROUTES`, not this table.
    expect(CORS_POLICY.open.some((s) => s.startsWith("/api/py"))).toBe(false);
    expect(sources.some((s) => s.startsWith("/api/py"))).toBe(false);
  });

  it("keeps one /api/py path, the hardware ingest URL, and it is the vercel.json rewrite", () => {
    // Consoles in the field upload to https://weather.mukoko.com/api/py/stations/ingest.
    // It is not a browser route (no CORS), and it is the only /api/py rewrite.
    const rewrites = (
      JSON.parse(
        readFileSync(resolve(__dirname, "../../vercel.json"), "utf-8"),
      ) as {
        rewrites: { source: string }[];
      }
    ).rewrites;
    expect(rewrites.map((r) => r.source)).toEqual([...CORS_POLICY.noCors]);
  });

  it("never sends credentials with the wildcard", () => {
    for (const r of wildcard)
      expect(
        r.headers.some((h) => h.key === "Access-Control-Allow-Credentials"),
      ).toBe(false);
  });

  it("opens nothing else: first-party routes get no wildcard", () => {
    expect(sources).toEqual([...CORS_POLICY.open].sort());
    for (const closed of [
      "/api/ai",
      "/api/keys",
      "/api/db-init",
      "/api/app-keys",
      "/api/devices",
      "/api/py/stations/ingest",
    ])
      expect(
        sources.some((s) => closed.startsWith(s.replace(/\/:path\*$/, ""))),
      ).toBe(false);
    expect(rules.some((r) => r.source === "/api/:path*")).toBe(false);
  });

  it("lists the first-party origins the API echoes", () => {
    expect(CORS_POLICY.allowlist).toEqual(
      expect.arrayContaining([
        "https://weather.mukoko.com",
        "https://weatherstations.nyuchi.com",
      ]),
    );
  });
});

describe("Permissions-Policy", () => {
  it("has no deprecated interest-cohort directive", () => {
    expect(PERMISSIONS_POLICY).not.toContain("interest-cohort");
  });
});
