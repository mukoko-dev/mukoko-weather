import { describe, it, expect } from "vitest";
import {
  moonPhase,
  nextMoonrise,
  MOON_PHASE_NAMES,
  SYNODIC_MONTH_DAYS,
} from "./moon";

const DAY_MS = 86_400_000;
const EPOCH_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14);

/** Date at which the mean phase equals `phase` (0–1) in the first cycle after the epoch. */
function atPhase(phase: number): Date {
  return new Date(EPOCH_NEW_MOON + phase * SYNODIC_MONTH_DAYS * DAY_MS);
}

/** Circular distance between two phases on [0, 1). */
function phaseDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 1;
  return Math.min(d, 1 - d);
}

describe("moonPhase", () => {
  it("is exactly new moon at the reference epoch", () => {
    const p = moonPhase(new Date(EPOCH_NEW_MOON));
    expect(p.phase).toBeCloseTo(0, 6);
    expect(p.illumination).toBeCloseTo(0, 6);
    expect(p.name).toBe("New moon");
  });

  it("names each of the eight phases at its centre", () => {
    const expected = [
      "New moon",
      "Waxing crescent",
      "First quarter",
      "Waxing gibbous",
      "Full moon",
      "Waning gibbous",
      "Last quarter",
      "Waning crescent",
    ];
    expect([...MOON_PHASE_NAMES]).toEqual(expected);
    for (let i = 0; i < 8; i++) {
      expect(moonPhase(atPhase(i / 8)).name).toBe(expected[i]);
    }
  });

  it("gives quarter moons 50% illumination", () => {
    expect(moonPhase(atPhase(0.25)).illumination).toBeCloseTo(0.5, 6);
    expect(moonPhase(atPhase(0.75)).illumination).toBeCloseTo(0.5, 6);
  });

  it("reaches full illumination at phase 0.5", () => {
    const p = moonPhase(atPhase(0.5));
    expect(p.phase).toBeCloseTo(0.5, 6);
    expect(p.illumination).toBeCloseTo(1, 6);
    expect(p.name).toBe("Full moon");
  });

  it("keeps phase in [0, 1) and illumination in [0, 1] across many years", () => {
    const start = Date.UTC(1990, 0, 1);
    for (let i = 0; i < 2000; i++) {
      const p = moonPhase(new Date(start + i * 0.37 * DAY_MS * 10));
      expect(p.phase).toBeGreaterThanOrEqual(0);
      expect(p.phase).toBeLessThan(1);
      expect(p.illumination).toBeGreaterThanOrEqual(0);
      expect(p.illumination).toBeLessThanOrEqual(1);
      expect(MOON_PHASE_NAMES).toContain(p.name);
    }
  });

  it("repeats every synodic month", () => {
    const d = new Date(Date.UTC(2026, 9, 8, 12));
    const a = moonPhase(d);
    const b = moonPhase(new Date(d.getTime() + SYNODIC_MONTH_DAYS * DAY_MS));
    expect(phaseDistance(a.phase, b.phase)).toBeLessThan(1e-6);
    expect(a.name).toBe(b.name);
  });

  it("handles dates before the epoch without going negative", () => {
    const p = moonPhase(new Date(Date.UTC(1950, 5, 1)));
    expect(p.phase).toBeGreaterThanOrEqual(0);
    expect(p.phase).toBeLessThan(1);
  });

  it("returns a safe default for an invalid date instead of throwing", () => {
    const p = moonPhase(new Date("not a date"));
    expect(p.phase).toBe(0);
    expect(p.name).toBe("New moon");
  });

  // Historical anchors from published astronomical tables (UTC).
  it("matches the new moon of 2024-01-11 11:57 UTC", () => {
    const p = moonPhase(new Date(Date.UTC(2024, 0, 11, 12, 0)));
    expect(p.illumination).toBeLessThan(0.02);
    expect(phaseDistance(p.phase, 0)).toBeLessThan(0.03);
  });

  it("matches the full moon of 2024-01-25 17:54 UTC", () => {
    const p = moonPhase(new Date(Date.UTC(2024, 0, 25, 18, 0)));
    expect(p.name).toBe("Full moon");
    expect(p.illumination).toBeGreaterThan(0.98);
  });

  it("puts a new moon around 2026-10-10 (mean-phase accuracy)", () => {
    const p = moonPhase(new Date(Date.UTC(2026, 9, 10, 12, 0)));
    expect(p.illumination).toBeLessThan(0.05);
  });

  it("puts a full moon around 2026-10-26", () => {
    const p = moonPhase(new Date(Date.UTC(2026, 9, 26, 12, 0)));
    expect(p.name).toBe("Full moon");
    expect(p.illumination).toBeGreaterThan(0.95);
  });
});

describe("nextMoonrise", () => {
  const HARARE = { lat: -17.83, lon: 31.05 };
  const SINGAPORE = { lat: 1.35, lon: 103.82 };

  it("returns a moonrise after the query time, within 25 hours (Harare)", () => {
    const from = new Date(2026, 9, 8, 12, 0);
    const rise = nextMoonrise(from, HARARE.lat, HARARE.lon);
    expect(rise).toBeInstanceOf(Date);
    const diff = rise!.getTime() - from.getTime();
    expect(diff).toBeGreaterThan(0);
    expect(diff).toBeLessThanOrEqual(25 * 3_600_000);
  });

  it("returns a moonrise within 25 hours (Singapore)", () => {
    const from = new Date(2026, 9, 8, 20, 0);
    const rise = nextMoonrise(from, SINGAPORE.lat, SINGAPORE.lon);
    expect(rise).toBeInstanceOf(Date);
    const diff = rise!.getTime() - from.getTime();
    expect(diff).toBeGreaterThan(0);
    expect(diff).toBeLessThanOrEqual(25 * 3_600_000);
  });

  it("gives successive moonrises roughly 24 h 50 min apart", () => {
    const from = new Date(2026, 9, 8, 12, 0);
    const first = nextMoonrise(from, HARARE.lat, HARARE.lon)!;
    const second = nextMoonrise(
      new Date(first.getTime() + 60_000),
      HARARE.lat,
      HARARE.lon,
    )!;
    const gapMin = (second.getTime() - first.getTime()) / 60_000;
    expect(gapMin).toBeGreaterThan(24 * 60 + 20);
    expect(gapMin).toBeLessThan(25 * 60 + 20);
  });

  it("returns a value for every day across a month in the tropics", () => {
    for (let day = 0; day < 30; day++) {
      const from = new Date(2026, 9, 1 + day, 6, 0);
      const rise = nextMoonrise(from, HARARE.lat, HARARE.lon);
      expect(rise).not.toBeNull();
      expect(rise!.getTime() - from.getTime()).toBeLessThanOrEqual(
        25 * 3_600_000,
      );
    }
  });

  it("never throws at extreme latitudes; any result is in the future and within the search window", () => {
    // At high latitudes the moon can skip whole days, so the 25 h bound does
    // not hold there; the search window is four calendar days.
    for (const lat of [89.9, 85, -85, 70]) {
      for (let day = 0; day < 30; day++) {
        const from = new Date(2026, 9, 1 + day, 12, 0);
        const rise = nextMoonrise(from, lat, 0);
        if (rise !== null) {
          expect(rise.getTime()).toBeGreaterThan(from.getTime());
          expect(rise.getTime() - from.getTime()).toBeLessThanOrEqual(
            4 * 24 * 3_600_000,
          );
        }
      }
    }
  });

  it("returns null for invalid input rather than throwing", () => {
    const from = new Date(2026, 9, 8, 12, 0);
    expect(nextMoonrise(from, Number.NaN, 0)).toBeNull();
    expect(nextMoonrise(from, 0, Number.NaN)).toBeNull();
    expect(nextMoonrise(from, 95, 0)).toBeNull();
    expect(nextMoonrise(new Date("bogus"), 0, 0)).toBeNull();
  });
});
