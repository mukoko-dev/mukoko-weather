import { describe, it, expect } from "vitest";
import {
  uvGauge,
  humidityGauge,
  cloudGauge,
  windGauge,
  pressureGauge,
  feelsLikeGauge,
} from "./AtmosphericSummary";

// ── uvGauge ────────────────────────────────────────────────────────────────

describe("uvGauge", () => {
  it("returns low severity for UV <= 2", () => {
    expect(uvGauge(0).strokeClass).toBe("stroke-severity-low");
    expect(uvGauge(2).strokeClass).toBe("stroke-severity-low");
  });

  it("returns moderate severity for UV 3-5", () => {
    expect(uvGauge(3).strokeClass).toBe("stroke-severity-moderate");
    expect(uvGauge(5).strokeClass).toBe("stroke-severity-moderate");
  });

  it("returns high severity for UV 6-7", () => {
    expect(uvGauge(6).strokeClass).toBe("stroke-severity-high");
    expect(uvGauge(7).strokeClass).toBe("stroke-severity-high");
  });

  it("returns severe severity for UV 8-10", () => {
    expect(uvGauge(8).strokeClass).toBe("stroke-severity-severe");
    expect(uvGauge(10).strokeClass).toBe("stroke-severity-severe");
  });

  it("returns extreme severity for UV > 10", () => {
    expect(uvGauge(11).strokeClass).toBe("stroke-severity-extreme");
  });

  it("caps percent at 100", () => {
    expect(uvGauge(15).percent).toBe(100);
  });

  it("uses severity stroke classes, not hardcoded colors", () => {
    for (const uv of [0, 3, 6, 8, 11]) {
      expect(uvGauge(uv).strokeClass).toMatch(/^stroke-severity-/);
    }
  });
});

// ── humidityGauge ──────────────────────────────────────────────────────────

describe("humidityGauge", () => {
  it("returns moderate for dry air (< 30%)", () => {
    expect(humidityGauge(10).strokeClass).toBe("stroke-severity-moderate");
  });

  it("returns low (comfortable) for 30-60%", () => {
    expect(humidityGauge(45).strokeClass).toBe("stroke-severity-low");
  });

  it("returns moderate for 61-80%", () => {
    expect(humidityGauge(70).strokeClass).toBe("stroke-severity-moderate");
  });

  it("returns high for > 80%", () => {
    expect(humidityGauge(90).strokeClass).toBe("stroke-severity-high");
  });

  it("percent equals the humidity value (0-100)", () => {
    expect(humidityGauge(50).percent).toBe(50);
    expect(humidityGauge(100).percent).toBe(100);
  });
});

// ── cloudGauge ─────────────────────────────────────────────────────────────

describe("cloudGauge", () => {
  it("returns low for cloud cover <= 50%", () => {
    expect(cloudGauge(25).strokeClass).toBe("stroke-severity-low");
    expect(cloudGauge(50).strokeClass).toBe("stroke-severity-low");
  });

  it("returns moderate for 51-75%", () => {
    expect(cloudGauge(60).strokeClass).toBe("stroke-severity-moderate");
    expect(cloudGauge(75).strokeClass).toBe("stroke-severity-moderate");
  });

  it("returns high for > 75%", () => {
    expect(cloudGauge(90).strokeClass).toBe("stroke-severity-high");
  });
});

// ── windGauge ──────────────────────────────────────────────────────────────

describe("windGauge", () => {
  it("returns low for calm winds (<= 19 km/h)", () => {
    expect(windGauge(10).strokeClass).toBe("stroke-severity-low");
  });

  it("returns moderate for moderate winds (20-38 km/h)", () => {
    expect(windGauge(25).strokeClass).toBe("stroke-severity-moderate");
  });

  it("returns high for strong winds (39-61 km/h)", () => {
    expect(windGauge(50).strokeClass).toBe("stroke-severity-high");
  });

  it("returns severe for very strong winds (> 61 km/h)", () => {
    expect(windGauge(70).strokeClass).toBe("stroke-severity-severe");
  });

  it("caps percent at 100 for speeds > 80 km/h", () => {
    expect(windGauge(100).percent).toBe(100);
  });
});

// ── pressureGauge ──────────────────────────────────────────────────────────

describe("pressureGauge", () => {
  it("returns moderate for low pressure (< 1000 hPa)", () => {
    expect(pressureGauge(990).strokeClass).toBe("stroke-severity-moderate");
  });

  it("returns low (normal) for 1000-1020 hPa", () => {
    expect(pressureGauge(1010).strokeClass).toBe("stroke-severity-low");
  });

  it("returns moderate for high pressure (> 1020 hPa)", () => {
    expect(pressureGauge(1030).strokeClass).toBe("stroke-severity-moderate");
  });

  it("clamps values to 980-1040 range", () => {
    const low = pressureGauge(950);
    expect(low.percent).toBe(0);
    const high = pressureGauge(1100);
    expect(high.percent).toBe(100);
  });
});

// ── feelsLikeGauge ─────────────────────────────────────────────────────────

describe("feelsLikeGauge", () => {
  it("returns low severity when feels-like ≈ actual (diff <= 2)", () => {
    expect(feelsLikeGauge(25, 24).strokeClass).toBe("stroke-severity-low");
  });

  it("guarantees minimum 8% arc for small differences", () => {
    expect(feelsLikeGauge(20, 20).percent).toBeGreaterThanOrEqual(8);
  });

  it("returns moderate for 3-5 degree difference", () => {
    expect(feelsLikeGauge(30, 25).strokeClass).toBe("stroke-severity-moderate");
  });

  it("returns high for 6-10 degree difference", () => {
    expect(feelsLikeGauge(35, 25).strokeClass).toBe("stroke-severity-high");
  });

  it("returns severe for > 10 degree difference", () => {
    expect(feelsLikeGauge(40, 25).strokeClass).toBe("stroke-severity-severe");
  });

  it("works symmetrically (cooler or warmer)", () => {
    const warmer = feelsLikeGauge(35, 25);
    const cooler = feelsLikeGauge(15, 25);
    expect(warmer.strokeClass).toBe(cooler.strokeClass);
    expect(warmer.percent).toBe(cooler.percent);
  });
});
