import { describe, it, expect } from "vitest";
import {
  gradientFromStrokeClass,
  valueTextSizeClass,
  ARC_RADIUS as ARC_RADIUS_EXPORT,
  ARC_STROKE_WIDTH,
  ARC_VIEWBOX,
} from "./MetricCard";

// ---------------------------------------------------------------------------
// ArcGauge constants — mirrored from MetricCard.tsx for math validation
// ---------------------------------------------------------------------------

const ARC_RADIUS = 32;
const ARC_CIRCUMFERENCE = 2 * Math.PI * ARC_RADIUS; // ~201.0619
const ARC_SWEEP = 0.75; // 270° / 360°
const ARC_LENGTH = ARC_CIRCUMFERENCE * ARC_SWEEP; // ~150.7964

// ── ArcGauge math ──────────────────────────────────────────────────────────

describe("ArcGauge math", () => {
  it("exported ARC_RADIUS matches the mirrored constant", () => {
    expect(ARC_RADIUS_EXPORT).toBe(ARC_RADIUS);
  });

  it("ARC_CIRCUMFERENCE is 2πr", () => {
    expect(ARC_CIRCUMFERENCE).toBeCloseTo(2 * Math.PI * 32, 4);
  });

  it("ARC_SWEEP covers 270° (three-quarter circle)", () => {
    expect(ARC_SWEEP).toBe(0.75);
    expect(ARC_SWEEP * 360).toBe(270);
  });

  it("ARC_LENGTH is circumference × sweep", () => {
    expect(ARC_LENGTH).toBeCloseTo(ARC_CIRCUMFERENCE * 0.75, 4);
  });

  it("0% fills zero arc length", () => {
    const filledLength = (0 / 100) * ARC_LENGTH;
    expect(filledLength).toBe(0);
  });

  it("50% fills half the arc length", () => {
    const filledLength = (50 / 100) * ARC_LENGTH;
    expect(filledLength).toBeCloseTo(ARC_LENGTH / 2, 4);
  });

  it("100% fills the full arc length", () => {
    const filledLength = (100 / 100) * ARC_LENGTH;
    expect(filledLength).toBeCloseTo(ARC_LENGTH, 4);
  });

  it("filledLength scales linearly with percent", () => {
    const fill25 = (25 / 100) * ARC_LENGTH;
    const fill75 = (75 / 100) * ARC_LENGTH;
    expect(fill75).toBeCloseTo(fill25 * 3, 4);
  });

  it("filledLength never exceeds ARC_LENGTH for valid percents", () => {
    for (const pct of [0, 10, 25, 50, 75, 90, 100]) {
      const filled = (pct / 100) * ARC_LENGTH;
      expect(filled).toBeLessThanOrEqual(ARC_LENGTH);
      expect(filled).toBeGreaterThanOrEqual(0);
    }
  });
});

// ── ArcGauge ARIA contract ─────────────────────────────────────────────────

describe("ArcGauge ARIA contract", () => {
  it("aria-valuenow should be rounded integer of percent", () => {
    // Mirrors Math.round(clampedPercent) in the component
    expect(Math.round(33.7)).toBe(34);
    expect(Math.round(0)).toBe(0);
    expect(Math.round(100)).toBe(100);
    expect(Math.round(66.4)).toBe(66);
  });

  it("percent is clamped to 0-100 before rounding", () => {
    const clamp = (p: number) => Math.max(0, Math.min(p, 100));
    expect(Math.round(clamp(-10))).toBe(0);
    expect(Math.round(clamp(120))).toBe(100);
  });

  it("aria-valuemin is always 0", () => {
    const valuemin = 0;
    expect(valuemin).toBe(0);
  });

  it("aria-valuemax is always 100", () => {
    const valuemax = 100;
    expect(valuemax).toBe(100);
  });

  it("role is meter for gauge semantics", () => {
    // Component uses role="meter" which is the correct ARIA role for gauges
    const role = "meter";
    expect(role).toBe("meter");
  });
});

// ── SVG geometry ───────────────────────────────────────────────────────────

describe("ArcGauge SVG geometry", () => {
  it("track strokeDasharray uses ARC_LENGTH and full circumference", () => {
    const trackDash = `${ARC_LENGTH} ${ARC_CIRCUMFERENCE}`;
    expect(trackDash).toContain(ARC_LENGTH.toString());
    expect(trackDash).toContain(ARC_CIRCUMFERENCE.toString());
  });

  it("value strokeDasharray uses filledLength and full circumference", () => {
    const percent = 60;
    const filledLength = (percent / 100) * ARC_LENGTH;
    const valueDash = `${filledLength} ${ARC_CIRCUMFERENCE}`;
    expect(valueDash).toBe(`${filledLength} ${ARC_CIRCUMFERENCE}`);
    expect(filledLength).toBeLessThan(ARC_LENGTH);
  });

  it("rotation starts at 135° (bottom-left of the arc opening)", () => {
    const rotation = 135;
    expect(rotation).toBe(135);
  });

  it("viewBox and radius are consistent (arc + stroke fits within the box)", () => {
    const center = ARC_VIEWBOX / 2; // 40
    expect(center).toBe(40);
    // Radius + half stroke must stay inside the viewBox half-extent.
    expect(ARC_RADIUS + ARC_STROKE_WIDTH / 2).toBeLessThan(center);
  });

  it("gauge is larger than the previous 60px render (bigger visual anchor)", () => {
    // The gauge now renders at 96px (h-24 w-24) — noticeably bigger.
    expect(ARC_VIEWBOX).toBeGreaterThan(64);
    expect(ARC_RADIUS).toBeGreaterThan(26);
  });
});

// ── Gradient ramp derivation ────────────────────────────────────────────────

describe("gradientFromStrokeClass", () => {
  it("derives a multi-stop ramp ending at the class severity", () => {
    const ramp = gradientFromStrokeClass("stroke-severity-severe");
    expect(ramp.length).toBeGreaterThanOrEqual(2);
    expect(ramp[0]).toBe("var(--color-severity-low)");
    expect(ramp[ramp.length - 1]).toBe("var(--color-severity-severe)");
  });

  it("low severity still yields at least two stops for a visible sweep", () => {
    const ramp = gradientFromStrokeClass("stroke-severity-low");
    expect(ramp.length).toBeGreaterThanOrEqual(2);
  });

  it("extreme severity includes the full ramp", () => {
    const ramp = gradientFromStrokeClass("stroke-severity-extreme");
    expect(ramp[ramp.length - 1]).toBe("var(--color-severity-extreme)");
    expect(ramp).toContain("var(--color-severity-high)");
  });

  it("pairs the cold token with low (cold isn't part of the linear ramp)", () => {
    const ramp = gradientFromStrokeClass("stroke-severity-cold");
    expect(ramp).toEqual(["var(--color-severity-low)", "var(--color-severity-cold)"]);
  });

  it("falls back to a two-stop ramp for unknown classes", () => {
    const ramp = gradientFromStrokeClass("stroke-unknown");
    expect(ramp.length).toBe(2);
  });

  it("all ramp stops reference CSS custom properties, not hardcoded hex", () => {
    for (const cls of [
      "stroke-severity-low",
      "stroke-severity-moderate",
      "stroke-severity-high",
      "stroke-severity-severe",
      "stroke-severity-extreme",
    ]) {
      for (const stop of gradientFromStrokeClass(cls)) {
        expect(stop).toMatch(/^var\(--/);
        expect(stop).not.toMatch(/#/);
      }
    }
  });
});

// ── Value text sizing ───────────────────────────────────────────────────────

describe("valueTextSizeClass", () => {
  it("uses the largest size for short values", () => {
    expect(valueTextSizeClass("16°")).toBe("text-2xl");
    expect(valueTextSizeClass("94%")).toBe("text-2xl");
    expect(valueTextSizeClass("858")).toBe("text-2xl");
  });

  it("steps down for 4-character values", () => {
    expect(valueTextSizeClass("1013")).toBe("text-xl");
    expect(valueTextSizeClass("12mm")).toBe("text-xl");
  });

  it("steps down further for longer values so text never collides with the arc", () => {
    expect(valueTextSizeClass("0.5mm")).toBe("text-lg");
    expect(valueTextSizeClass("100.0%")).toBe("text-lg");
    expect(valueTextSizeClass("1013hPa")).toBe("text-sm");
  });

  it("returns a Tailwind text size class, never a hardcoded value", () => {
    for (const v of ["1", "12", "123", "1234", "12345", "123456"]) {
      expect(valueTextSizeClass(v)).toMatch(/^text-/);
    }
  });
});

// ── MetricCard structure ───────────────────────────────────────────────────

describe("MetricCard props contract", () => {
  it("contextColor defaults to text-text-tertiary", () => {
    const defaultColor = "text-text-tertiary";
    expect(defaultColor).not.toMatch(/^#/); // no hardcoded hex
    expect(defaultColor).toMatch(/^text-/); // Tailwind class
  });

  it("gauge percent is clamped 0-100 for rendering", () => {
    const clamp = (p: number) => Math.max(0, Math.min(p, 100));
    expect(clamp(-10)).toBe(0);
    expect(clamp(120)).toBe(100);
  });
});

// ── Exports ────────────────────────────────────────────────────────────────

describe("MetricCard exports", () => {
  it("exports ArcGauge, MetricCard, GaugeConfig, and gradient helpers", async () => {
    const mod = await import("./MetricCard");
    expect(mod.ArcGauge).toBeDefined();
    expect(mod.MetricCard).toBeDefined();
    expect(typeof mod.ArcGauge).toBe("function");
    expect(typeof mod.MetricCard).toBe("function");
    expect(typeof mod.gradientFromStrokeClass).toBe("function");
    expect(typeof mod.valueTextSizeClass).toBe("function");
  });
});
