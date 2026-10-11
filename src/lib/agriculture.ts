/**
 * Agriculture helpers — pure, framework-free.
 *
 * Types mirror `api/py/_agriculture.py` (`AgricultureResponse`,
 * `AgriAIResponse`). Keep the two in sync. Status classes are static
 * lookups so Tailwind sees every class name at build time.
 */

import { ACTIVITIES } from "./activities";

export type WindowStatus = "go" | "wait" | "avoid";
export type RiskLevel = "none" | "moderate" | "high";
export type MoistureBand = "dry" | "adequate" | "moist" | "saturated";
export type BalanceStatus = "deficit" | "balanced" | "surplus";
export type AgriAIMode = "snapshot" | "briefing";

export interface TimeWindow {
  start: string;
  end: string;
  hours: number;
}

export interface FarmWindow {
  status: WindowStatus;
  label: string;
  detail: string;
  window?: TimeWindow | null;
}

export interface FarmWindows {
  spray: FarmWindow;
  plant: FarmWindow;
  harvest: FarmWindow;
  irrigate: FarmWindow;
}

export interface Risk {
  level: RiskLevel;
  days: string[];
  extremeC: number | null;
  detail: string;
}

export interface AgriDay {
  date: string;
  forecast: boolean;
  rainMm: number | null;
  rainProbability: number | null;
  et0Mm: number | null;
  balanceMm: number | null;
  tMax: number | null;
  tMin: number | null;
  windMaxKmh: number | null;
  gdd: number | null;
  gddCumulative: number | null;
  soilMoisture0to1: number | null;
  soilMoisture1to3: number | null;
  soilMoisture3to9: number | null;
  soilMoisture9to27: number | null;
  soilMoisture27to81: number | null;
  soilTemp0: number | null;
  soilTemp6: number | null;
  soilTemp18: number | null;
  soilTemp54: number | null;
  vpdMaxKpa: number | null;
  leafWetHours: number | null;
  sprayHours: number | null;
}

export interface CropCalendar {
  id: string;
  label: string;
  phase: string | null;
  months: Partial<Record<"nursery" | "plant" | "grow" | "harvest", number[]>>;
}

export interface AgricultureResponse {
  available: boolean;
  reason?: string | null;
  headline: string | null;
  verdict: WindowStatus | null;
  windows: FarmWindows | null;
  rain: {
    next24hMm: number | null;
    next7dMm: number | null;
    next16dMm: number | null;
    past7dMm: number | null;
    past30dMm: number | null;
    rainyDaysNext7: number;
    nextRainDate: string | null;
  } | null;
  soil: {
    moistureTopsoil: number | null;
    moistureRootZone: number | null;
    moistureBand: MoistureBand | null;
    temperatureSurface: number | null;
    temperatureSeedDepth: number | null;
    temperatureRootZone: number | null;
  } | null;
  waterBalance: {
    et0Next7dMm: number | null;
    rainNext7dMm: number | null;
    balanceNext7dMm: number | null;
    et0Past7dMm: number | null;
    rainPast7dMm: number | null;
    balancePast7dMm: number | null;
    status: BalanceStatus | null;
  } | null;
  gdd: {
    base: number;
    cap: number;
    today: number | null;
    past30d: number | null;
    next7d: number | null;
  } | null;
  risks: { frost: Risk; heat: Risk } | null;
  wind: {
    speedKmh: number | null;
    gustKmh: number | null;
    sprayable: boolean;
    detail: string;
  } | null;
  sprayWindows: TimeWindow[];
  daily: AgriDay[];
  season: { name: string; localName: string; description: string } | null;
  calendar: CropCalendar[];
  profile: {
    koppen: string | null;
    normalHigh: number | null;
    normalLow: number | null;
    ensoPhase: string | null;
  } | null;
  crops: string[];
  timezone: string | null;
  utcOffsetSeconds: number | null;
  elevation: number | null;
  attribution: string;
  fetchedAt: string;
}

export interface AgriAIResponse {
  text: string;
  source: "ai" | "fallback";
  cached: boolean;
  mode: AgriAIMode;
  generatedAt: string;
}

/** Farming activity ids, derived from the activity catalogue (one source). */
export const FARMING_ACTIVITY_IDS: readonly string[] = ACTIVITIES.filter(
  (a) => a.category === "farming",
).map((a) => a.id);

/** The user's selected activities that are farming ones, in order, de-duplicated. */
export function farmingActivities(selected: readonly string[]): string[] {
  const farming = new Set(FARMING_ACTIVITY_IDS);
  return [...new Set(selected)].filter((id) => farming.has(id));
}

interface AgriLocationRef {
  slug: string;
  lat: number;
  lon: number;
  country?: string;
}

/** `/api/py/agriculture?...` for a location and the user's farming activities. */
export function agricultureUrl(
  location: AgriLocationRef,
  crops: readonly string[] = [],
): string {
  const params = new URLSearchParams({
    lat: String(location.lat),
    lon: String(location.lon),
    location: location.slug,
  });
  if (location.country) params.set("country", location.country);
  if (crops.length) params.set("crops", crops.join(","));
  return `/api/py/agriculture?${params.toString()}`;
}

export const WINDOW_ORDER: readonly (keyof FarmWindows)[] = [
  "spray",
  "plant",
  "harvest",
  "irrigate",
];

export const WINDOW_TITLES: Record<keyof FarmWindows, string> = {
  spray: "Spray",
  plant: "Plant",
  harvest: "Harvest",
  irrigate: "Irrigate",
};

export const STATUS_LABELS: Record<WindowStatus, string> = {
  go: "Go",
  wait: "Wait",
  avoid: "Hold off",
};

export interface StatusClasses {
  text: string;
  soft: string;
  dot: string;
}

const STATUS_CLASSES: Record<WindowStatus, StatusClasses> = {
  go: {
    text: "text-severity-low",
    soft: "bg-severity-low/15",
    dot: "bg-severity-low",
  },
  wait: {
    text: "text-severity-moderate",
    soft: "bg-severity-moderate/15",
    dot: "bg-severity-moderate",
  },
  avoid: {
    text: "text-severity-severe",
    soft: "bg-severity-severe/15",
    dot: "bg-severity-severe",
  },
};

/** Severity-token classes for a window status (static lookup). */
export function statusClasses(status: WindowStatus): StatusClasses {
  return STATUS_CLASSES[status];
}

const RISK_CLASSES: Record<RiskLevel, string> = {
  none: "text-severity-low",
  moderate: "text-severity-moderate",
  high: "text-severity-severe",
};

export function riskClass(level: RiskLevel): string {
  return RISK_CLASSES[level];
}

export const MOISTURE_LABELS: Record<MoistureBand, string> = {
  dry: "Dry",
  adequate: "Adequate",
  moist: "Moist",
  saturated: "Saturated",
};

export function formatMm(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value >= 10 || value === 0
    ? `${Math.round(value)} mm`
    : `${value.toFixed(1)} mm`;
}

/** Signed water balance, e.g. "−18 mm" / "+6 mm". */
export function formatBalance(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const rounded = Math.round(value);
  if (rounded === 0) return "0 mm";
  return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded)} mm`;
}

/** Volumetric soil water as a percentage, e.g. 0.27 → "27%". */
export function formatMoisture(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${Math.round(value * 100)}%`;
}

export function formatTempC(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${Math.round(value)}°C`;
}

export function formatGdd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${Math.round(value)}`;
}

/** "06:00" from a local ISO timestamp such as "2026-10-11T06:00". */
export function hhmm(iso: string): string {
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m ? m[1] : iso;
}

/** Only show the card when the backend produced a full picture. */
export function isAgricultureReady(
  data: AgricultureResponse | null | undefined,
): data is AgricultureResponse & {
  headline: string;
  verdict: WindowStatus;
  windows: FarmWindows;
  rain: NonNullable<AgricultureResponse["rain"]>;
} {
  return Boolean(
    data?.available &&
    data.windows &&
    data.rain &&
    data.headline &&
    data.verdict,
  );
}

/** Forecast days only (the charts' 16-day window). */
export function forecastDays(daily: readonly AgriDay[]): AgriDay[] {
  return daily.filter((d) => d.forecast);
}

/** Short x-axis label "13 Oct" from "2026-10-13" (no Date parsing, no TZ drift). */
export function dayLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return date;
  const months = [
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
  return `${Number(m[3])} ${months[Number(m[2]) - 1] ?? ""}`.trim();
}
