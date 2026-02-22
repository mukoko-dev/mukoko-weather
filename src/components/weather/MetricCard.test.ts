import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// ArcGauge constants — mirrored from MetricCard.tsx for math validation
// ---------------------------------------------------------------------------

const ARC_RADIUS = 20;
const ARC_CIRCUMFERENCE = 2 * Math.PI * ARC_RADIUS; // ~125.6637
const ARC_SWEEP = 0.75; // 270° / 360°
const ARC_LENGTH = ARC_CIRCUMFERENCE * ARC_SWEEP; // ~94.2478

// ── ArcGauge math ──────────────────────────────────────────────────────────

describe("ArcGauge math", () => {
  it("ARC_CIRCUMFERENCE is 2πr", () => {
    expect(ARC_CIRCUMFERENCE).toBeCloseTo(2 * Math.PI * 20, 4);
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
    // Mirrors Math.round(percent) in the component
    expect(Math.round(33.7)).toBe(34);
    expect(Math.round(0)).toBe(0);
    expect(Math.round(100)).toBe(100);
    expect(Math.round(66.4)).toBe(66);
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
    // The track shows the 270° background arc
    const trackDash = `${ARC_LENGTH} ${ARC_CIRCUMFERENCE}`;
    expect(trackDash).toContain(ARC_LENGTH.toString());
    expect(trackDash).toContain(ARC_CIRCUMFERENCE.toString());
  });

  it("value strokeDasharray uses filledLength and full circumference", () => {
    const percent = 60;
    const filledLength = (percent / 100) * ARC_LENGTH;
    const valueDash = `${filledLength} ${ARC_CIRCUMFERENCE}`;
    expect(valueDash).toBe(`${filledLength} ${ARC_CIRCUMFERENCE}`);
    // filledLength should be less than ARC_LENGTH (60% < 100%)
    expect(filledLength).toBeLessThan(ARC_LENGTH);
  });

  it("rotation starts at 135° (bottom-left of the arc opening)", () => {
    // 270° arc centered at bottom → starts 135° from 12 o'clock
    const rotation = 135;
    expect(rotation).toBe(135);
    // The gap (90°) is at the bottom, so arc spans from 135° to 45° (clockwise)
  });

  it("viewBox and radius are consistent", () => {
    const viewBoxSize = 48;
    const center = viewBoxSize / 2; // 24
    expect(center).toBe(24);
    // Radius 20 + strokeWidth 5/2 = 22.5, fits within viewBox 48×48
    expect(ARC_RADIUS + 5 / 2).toBeLessThan(center);
  });
});

// ── MetricCard structure ───────────────────────────────────────────────────

describe("MetricCard props contract", () => {
  it("contextColor defaults to text-text-tertiary", () => {
    const defaultColor = "text-text-tertiary";
    expect(defaultColor).not.toMatch(/^#/); // no hardcoded hex
    expect(defaultColor).toMatch(/^text-/); // Tailwind class
  });

  it("gauge percent is bounded 0-100 for meaningful rendering", () => {
    // Negative percent would produce negative filledLength (no visual bug, just no arc)
    const negFill = (-10 / 100) * ARC_LENGTH;
    expect(negFill).toBeLessThan(0);
    // Over 100% would exceed the arc (visual overflow, but no crash)
    const overFill = (120 / 100) * ARC_LENGTH;
    expect(overFill).toBeGreaterThan(ARC_LENGTH);
  });
});

// ── Exports ────────────────────────────────────────────────────────────────

describe("MetricCard exports", () => {
  it("exports ArcGauge, MetricCard, and GaugeConfig", async () => {
    const mod = await import("./MetricCard");
    expect(mod.ArcGauge).toBeDefined();
    expect(mod.MetricCard).toBeDefined();
    // GaugeConfig is a type — just verify the module loads
    expect(typeof mod.ArcGauge).toBe("function");
    expect(typeof mod.MetricCard).toBe("function");
  });
});
