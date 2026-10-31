/**
 * Frost alert colours: blues, light (advisory) to dark (severe), from the
 * `--wx-frost-*` weather-scale tokens (weather-scales.ts FROST_SCALE). Cold is
 * blue everywhere; the old red "severe frost" banner read as a heat warning.
 * Text stays on the primary text token: the blue is the edge and tint, never
 * the only signal (the title names the level).
 */
export type FrostRisk = "severe" | "high" | "moderate";

export const FROST_BANNER_CLASSES: Record<
  FrostRisk,
  { border: string; bg: string }
> = {
  moderate: { border: "border-wx-frost-1", bg: "bg-wx-frost-1/15" },
  high: { border: "border-wx-frost-2", bg: "bg-wx-frost-2/15" },
  severe: { border: "border-wx-frost-3", bg: "bg-wx-frost-3/15" },
};
