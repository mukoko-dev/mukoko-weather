/**
 * Haze panel helpers — pure, framework-free.
 *
 * Vocabulary mirrors `api/py/_haze.py` (levels, types, season + official
 * shapes). Keep the two in sync. Severity classes are static lookups so
 * Tailwind can see every class name at build time.
 */

export type HazeLevel = "none" | "light" | "moderate" | "heavy" | "hazardous";
export type HazeType = "clear" | "smoke" | "dust" | "smog" | "mist";
export type HazeSeasonType = "smoke" | "dust" | "smog";

export interface HazeSeason {
  name: string;
  active: boolean;
  typicalMonths: number[];
  typicalType: HazeSeasonType;
}

export interface HazeOfficial {
  source: string;
  metric: string;
  value: number;
  band: string;
  region: string;
  observedAt?: string | null;
}

export interface HazeResponse {
  available: boolean;
  reason?: string | null;
  level: HazeLevel | null;
  type: HazeType | null;
  headline: string | null;
  advice: string[];
  visibilityKm: number | null;
  pm25: number | null;
  pm25Mean: number | null;
  dust: number | null;
  aod: number | null;
  usAqi: number | null;
  relativeHumidity: number | null;
  peakTime: string | null;
  season: HazeSeason | null;
  official: HazeOfficial | null;
  attribution: string;
  fetchedAt: string;
}

/** Ordered least → most severe. */
export const HAZE_LEVEL_ORDER: readonly HazeLevel[] = [
  "none",
  "light",
  "moderate",
  "heavy",
  "hazardous",
];

export const HAZE_LEVEL_LABELS: Record<HazeLevel, string> = {
  none: "None",
  light: "Light",
  moderate: "Moderate",
  heavy: "Heavy",
  hazardous: "Hazardous",
};

export function hazeLevelRank(level: HazeLevel): number {
  return HAZE_LEVEL_ORDER.indexOf(level);
}

export interface HazeSeverityClasses {
  /** Text colour for chips and labels. */
  text: string;
  /** Solid fill for scale segments. */
  fill: string;
  /** Soft tinted background for chips. */
  soft: string;
}

const HAZE_SEVERITY: Record<HazeLevel, HazeSeverityClasses> = {
  none: {
    text: "text-severity-low",
    fill: "bg-severity-low",
    soft: "bg-severity-low/15",
  },
  light: {
    text: "text-severity-moderate",
    fill: "bg-severity-moderate",
    soft: "bg-severity-moderate/15",
  },
  moderate: {
    text: "text-severity-high",
    fill: "bg-severity-high",
    soft: "bg-severity-high/15",
  },
  heavy: {
    text: "text-severity-severe",
    fill: "bg-severity-severe",
    soft: "bg-severity-severe/15",
  },
  hazardous: {
    text: "text-severity-extreme",
    fill: "bg-severity-extreme",
    soft: "bg-severity-extreme/15",
  },
};

/** Severity token classes for a haze level (static lookup, never built dynamically). */
export function hazeSeverityClasses(level: HazeLevel): HazeSeverityClasses {
  return HAZE_SEVERITY[level];
}

export const HAZE_TYPE_LABELS: Record<HazeType, string> = {
  clear: "Clear",
  smoke: "Smoke",
  dust: "Dust",
  smog: "Smog",
  mist: "Mist",
};

/**
 * Icon key per haze type. The component maps these keys to the shared
 * `weather-icons` components, keeping this module free of React.
 */
export type HazeIconKey = "sun" | "cloud" | "wind" | "factory" | "fog";

export const HAZE_TYPE_ICON: Record<HazeType, HazeIconKey> = {
  clear: "sun",
  smoke: "cloud",
  dust: "wind",
  smog: "factory",
  mist: "fog",
};

const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Should the haze panel render at all?
 * - Haze now: level light or above and a type that is not mist or clear.
 * - Or an active haze season with elevated readings (level light or above).
 * Otherwise the panel renders nothing (no empty card).
 */
export function isHazeWorthShowing(
  level: HazeLevel | null | undefined,
  type: HazeType | null | undefined,
  season: HazeSeason | null | undefined,
): boolean {
  if (!level || level === "none") return false;
  if (type && type !== "mist" && type !== "clear") return true;
  return Boolean(season?.active);
}

/** "Nov–Mar" from a month list in window order (first = start, last = end). */
export function formatMonthSpan(months: readonly number[]): string {
  const valid = months.filter((m) => Number.isInteger(m) && m >= 1 && m <= 12);
  if (valid.length === 0) return "";
  const first = valid[0];
  const last = valid[valid.length - 1];
  if (first === last) return MONTH_ABBR[first - 1];
  return `${MONTH_ABBR[first - 1]}–${MONTH_ABBR[last - 1]}`;
}

/** "07:00" from a local ISO timestamp such as "2026-10-09T07:00". */
export function formatPeakTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const match = /T(\d{2}:\d{2})/.exec(iso);
  return match ? match[1] : null;
}

export function formatVisibility(km: number | null | undefined): string {
  if (km === null || km === undefined) return "—";
  return `${km.toFixed(1)} km`;
}

export function formatMicrograms(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${Math.round(value)} µg/m³`;
}

/** "NEA Singapore PSI 142 · Unhealthy · West". */
export function formatOfficialLine(official: HazeOfficial): string {
  return `${official.source} ${official.metric} ${official.value} · ${official.band} · ${official.region}`;
}
