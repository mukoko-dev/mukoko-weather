/**
 * Contextual label helpers for weather metrics.
 *
 * These are extracted from AtmosphericSummary.tsx so they can be
 * unit-tested and reused across components.
 */

/** Map humidity percentage to a human-readable label */
export function humidityLabel(h: number): string {
  if (h <= 30) return "Dry";
  if (h <= 60) return "Comfortable";
  if (h <= 80) return "Humid";
  return "Very humid";
}

/** Map pressure (hPa) to a human-readable label */
export function pressureLabel(p: number): string {
  if (p < 1000) return "Low";
  if (p <= 1020) return "Normal";
  return "High";
}

/** Map cloud cover percentage to a human-readable label */
export function cloudLabel(c: number): string {
  if (c <= 10) return "Clear";
  if (c <= 30) return "Mostly clear";
  if (c <= 70) return "Partly cloudy";
  if (c <= 90) return "Mostly cloudy";
  return "Overcast";
}

/** Describe the feels-like temperature relative to actual */
export function feelsLikeContext(apparent: number, actual: number): string {
  if (apparent < actual) return "Cooler than actual";
  if (apparent > actual) return "Warmer than actual";
  return "Same as actual";
}
