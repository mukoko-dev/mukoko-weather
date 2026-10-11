import { describe, it, expect } from "vitest";
import nextConfig from "../../next.config";
import { buildCsp, CSP_DIRECTIVES } from "./security-headers";

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
      "https://fonts.googleapis.com",
      "https://fonts.gstatic.com",
      "https://api.workos.com",
    ])
      expect(csp).toContain(host);
    expect(CSP_DIRECTIVES["worker-src"]).toContain("blob:");
    expect(CSP_DIRECTIVES["img-src"]).toEqual(
      expect.arrayContaining(["data:", "blob:"]),
    );
    expect(CSP_DIRECTIVES["object-src"]).toEqual(["'none'"]);
  });
});

describe("CORS (B06)", () => {
  it("opens only the public embed endpoints", () => {
    const open = rules.filter((r) =>
      r.headers.some(
        (h) => h.key === "Access-Control-Allow-Origin" && h.value === "*",
      ),
    );
    expect(open.map((r) => r.source).sort()).toEqual([
      "/api/embed/:path*",
      "/embed/:path*",
    ]);
  });
  it("sets no wildcard CORS on /api/py, /api/ai, /api/keys", () => {
    expect(rules.some((r) => r.source === "/api/:path*")).toBe(false);
  });
});
