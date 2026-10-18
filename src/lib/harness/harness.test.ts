import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { LIVE_REGION_ID, motionConfigFor } from "./index";

const source = readFileSync(resolve(__dirname, "index.tsx"), "utf-8");

describe("Mzizi harness — motion", () => {
  it("zeroes durations and stagger under reduced motion", () => {
    const m = motionConfigFor(true);
    expect(m.enterDuration).toBe(0);
    expect(m.exitDuration).toBe(0);
    expect(m.staggerDelay(5)).toBe(0);
    expect(m.enterEasing).toBe("linear");
  });

  it("keeps the upstream timings otherwise, stagger capped at 8", () => {
    const m = motionConfigFor(false);
    expect(m.enterDuration).toBe(200);
    expect(m.exitDuration).toBe(100);
    expect(m.staggerDelay(2)).toBe(100);
    expect(m.staggerDelay(20)).toBe(400);
  });

  it("follows a live prefers-reduced-motion change, SSR-safe", () => {
    expect(source).toContain("useSyncExternalStore(");
    expect(source).toContain('"(prefers-reduced-motion: reduce)"');
    expect(source).toContain("() => false,");
  });
});

describe("Mzizi harness — announcer and boundary", () => {
  it("uses one shared polite live region", () => {
    expect(LIVE_REGION_ID).toBe("nyuchi-live-region");
    expect(source).toContain('el.setAttribute("aria-live", "polite")');
    expect(source).toContain('el.className = "sr-only"');
  });

  it("wraps children in an error boundary with a replaceable fallback", () => {
    expect(source).toContain("getDerivedStateFromError");
    expect(source).toContain("this.props.fallback ??");
    expect(source).toContain('data-slot="mzizi-harness"');
  });

  it("uses app tokens, no hardcoded colours or radii", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toContain("14px");
  });
});
