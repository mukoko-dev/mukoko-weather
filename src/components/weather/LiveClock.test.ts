/**
 * Tests for LiveClock — the location-page date/time line.
 *
 * Covers the pure `formatDateTime` helper (deterministic given a Date) and the
 * deterministic-render contract that kills the hydration text mismatch that
 * caused React error #418: the clock is gated behind `useHydrated()` so the
 * server and first client render emit identical HTML, and it no longer relies
 * on `suppressHydrationWarning` to paper over a real mismatch.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { formatDateTime } from "./LiveClock";

const source = readFileSync(resolve(__dirname, "LiveClock.tsx"), "utf-8");

describe("formatDateTime", () => {
  // Dates are constructed with local-time components and formatted in the
  // runtime's local timezone, so these assertions hold regardless of the CI
  // machine's timezone.
  it("formats as 'Weekday, D Month YYYY at HH:MM'", () => {
    // 2026-07-03 08:33 local → the exact string observed on the live page.
    expect(formatDateTime(new Date(2026, 6, 3, 8, 33))).toBe(
      "Friday, 3 July 2026 at 08:33",
    );
  });

  it("zero-pads the hour and minute to two digits", () => {
    expect(formatDateTime(new Date(2026, 0, 5, 9, 5))).toBe(
      "Monday, 5 January 2026 at 09:05",
    );
  });

  it("uses 24-hour time (no am/pm)", () => {
    const label = formatDateTime(new Date(2026, 6, 3, 20, 15));
    expect(label).toContain("20:15");
    expect(label.toLowerCase()).not.toContain("pm");
  });
});

describe("LiveClock — deterministic render", () => {
  it("exports the LiveClock component and the formatDateTime helper", () => {
    expect(source).toContain("export function LiveClock");
    expect(source).toContain("export function formatDateTime");
  });

  it("gates the clock on useHydrated so SSR + hydration render identical HTML", () => {
    expect(source).toContain("useHydrated");
    expect(source).toContain("if (!hydrated) return null");
  });

  it("does NOT rely on suppressHydrationWarning to hide a real mismatch", () => {
    expect(source).not.toContain("suppressHydrationWarning");
  });

  it("still refreshes every minute via an interval", () => {
    expect(source).toContain("setInterval");
    expect(source).toContain("60_000");
    expect(source).toContain("clearInterval");
  });
});
