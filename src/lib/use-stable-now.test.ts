import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { seedNowMs } from "./use-stable-now";

describe("seedNowMs — the instant both server and client render first", () => {
  it("reads a naive Open-Meteo wall-clock time in the location's offset", () => {
    // 14:15 in Harare (UTC+2) is 12:15 UTC.
    expect(seedNowMs("2026-10-16T14:15", 7200)).toBe(
      Date.UTC(2026, 9, 16, 12, 15),
    );
  });

  it("reads a zoned instant as is", () => {
    expect(seedNowMs("2026-10-16T12:15:00Z", 7200)).toBe(
      Date.UTC(2026, 9, 16, 12, 15),
    );
  });

  it("is deterministic (same payload, same value) — never the wall clock", () => {
    const a = seedNowMs("2026-10-16T14:15", 7200);
    const b = seedNowMs("2026-10-16T14:15", 7200);
    expect(a).toBe(b);
  });

  it("falls back to 0 for a missing or bad time", () => {
    expect(seedNowMs(undefined, 0)).toBe(0);
    expect(seedNowMs("not a time", null)).toBe(0);
  });
});

describe("AtmosphericSummary reads the clock hydration-safely", () => {
  const src = readFileSync(
    resolve(__dirname, "../components/weather/AtmosphericSummary.tsx"),
    "utf-8",
  );
  const body = src.slice(src.indexOf("export function AtmosphericSummary"));

  it("never calls new Date() in the render body", () => {
    const render = body.slice(0, body.indexOf("return ("));
    expect(render).not.toContain("new Date()");
    expect(render).toContain("useStableNow(");
    expect(render).toContain("seedNowMs(data.current?.time");
  });
});
