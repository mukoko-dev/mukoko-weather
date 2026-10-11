import { describe, it, expect } from "vitest";
import { createReportGate, parseCspReports } from "./csp-report";

describe("parseCspReports", () => {
  it("handles the Reporting API array shape", () => {
    const out = parseCspReports([
      {
        body: {
          effectiveDirective: "connect-src",
          blockedURL: "https://a.example/x/y",
          documentURL: "https://weather.mukoko.com/harare",
        },
      },
    ]);
    expect(out).toEqual([
      { directive: "connect-src", blocked: "a.example", page: "/harare" },
    ]);
  });
  it("keeps keywords and schemes, drops extension schemes", () => {
    const e = (b: string) => ({ "csp-report": { "blocked-uri": b } });
    expect(parseCspReports(e("inline"))[0].blocked).toBe("inline");
    expect(parseCspReports(e("data:image/png;base64,AAA"))[0].blocked).toBe(
      "data",
    );
    expect(parseCspReports(e("moz-extension://x/y"))).toEqual([]);
    expect(parseCspReports(e("safari-web-extension://x"))).toEqual([]);
  });
  it("caps items per request", () => {
    const many = Array.from({ length: 20 }, () => ({
      "csp-report": { "blocked-uri": "https://a.example" },
    }));
    expect(parseCspReports(many)).toHaveLength(5);
  });
});

describe("createReportGate", () => {
  const e = (n: number) => ({
    directive: "img-src",
    blocked: `h${n}`,
    page: "/",
  });
  it("dedupes inside the window and allows again after it", () => {
    const g = createReportGate({ dedupeMs: 1000 });
    expect(g.allow(e(1), 0)).toBe(true);
    expect(g.allow(e(1), 500)).toBe(false);
    expect(g.allow(e(1), 1500)).toBe(true);
  });
  it("rate-limits distinct reports per minute", () => {
    const g = createReportGate({ maxPerMinute: 3 });
    expect([1, 2, 3, 4].map((n) => g.allow(e(n), 10))).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(g.allow(e(5), 61_000)).toBe(true);
  });
  it("bounds memory", () => {
    const g = createReportGate({ maxKeys: 2, maxPerMinute: 99 });
    g.allow(e(1), 0);
    g.allow(e(2), 0);
    expect(g.allow(e(3), 0)).toBe(false);
  });
});
