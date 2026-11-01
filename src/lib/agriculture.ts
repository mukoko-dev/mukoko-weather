/**
 * Agriculture helpers — pure, framework-free.
 *
 * Types mirror `api/py/_agriculture.py` (`AgricultureResponse`,
 * `AgriAIResponse`). Keep the two in sync. Status classes are static
 * lookups so Tailwind sees every class name at build time.
 */

import { workerUrl } from "./weather-api";
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

/** The Worker's `/v1/agriculture?...` for a location and the user's farming activities. */
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
  return workerUrl("agriculture", params.toString());
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

// ---------------------------------------------------------------------------
// Insights page helpers (chart rows, calendar, crop advice)
// ---------------------------------------------------------------------------

/** One chart point: an x label plus numeric series (null = gap). */
export type AgriChartRow = Record<string, string | number | null>;

const pct = (v: number | null): number | null =>
  v === null ? null : Math.round(v * 1000) / 10;

/** 16-day forecast rows for the rain/ET₀, balance, soil and spray charts. */
export function forecastChartRows(daily: readonly AgriDay[]): AgriChartRow[] {
  let running = 0;
  return forecastDays(daily).map((d) => {
    if (d.balanceMm !== null) running += d.balanceMm;
    return {
      date: dayLabel(d.date),
      rainMm: d.rainMm,
      et0Mm: d.et0Mm,
      balanceMm: d.balanceMm,
      cumulativeBalanceMm:
        d.balanceMm === null ? null : Math.round(running * 10) / 10,
      sm0to1: pct(d.soilMoisture0to1),
      sm1to3: pct(d.soilMoisture1to3),
      sm3to9: pct(d.soilMoisture3to9),
      sm9to27: pct(d.soilMoisture9to27),
      sm27to81: pct(d.soilMoisture27to81),
      st0: d.soilTemp0,
      st6: d.soilTemp6,
      st18: d.soilTemp18,
      st54: d.soilTemp54,
      sprayHours: d.sprayHours,
      leafWetHours: d.leafWetHours,
    };
  });
}

/** Cumulative GDD (base 10) over the past 30 days and the forecast. */
export function gddRows(daily: readonly AgriDay[]): AgriChartRow[] {
  return daily.map((d) => ({
    date: dayLabel(d.date),
    gddMaize: d.gddCumulative,
  }));
}

/** True when a series has at least one value (charts skip empty ones). */
export function hasSeries(
  rows: readonly AgriChartRow[],
  keys: readonly string[],
): boolean {
  return rows.some((r) => keys.some((k) => typeof r[k] === "number"));
}

export const MONTH_ABBR = [
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
] as const;

export type CropStage = "nursery" | "plant" | "grow" | "harvest";

export const STAGE_LABELS: Record<CropStage, string> = {
  nursery: "Nursery",
  plant: "Plant",
  grow: "Grow",
  harvest: "Harvest",
};

/** Static class lookup per stage (malachite family + gold for harvest). */
export const STAGE_CLASSES: Record<CropStage, string> = {
  nursery: "bg-mineral-malachite/15 text-text-primary",
  plant: "bg-mineral-malachite text-mineral-malachite-fg",
  grow: "bg-mineral-malachite/35 text-text-primary",
  harvest: "bg-mineral-gold text-mineral-gold-fg",
};

/** The stage a crop is in for a 1-based month, or null. */
export function stageForMonth(
  crop: CropCalendar,
  month: number,
): CropStage | null {
  for (const stage of ["nursery", "plant", "grow", "harvest"] as const) {
    if (crop.months[stage]?.includes(month)) return stage;
  }
  return null;
}

/** Display label for an activity id from the catalogue. */
export function cropLabel(id: string): string {
  return ACTIVITIES.find((a) => a.id === id)?.label ?? id;
}

export interface CropAdvice {
  id: string;
  label: string;
  tips: string[];
}

/**
 * Deterministic, crop-aware notes from the farm data — no AI call. At most
 * three tips per crop, each tied to a number the page also shows.
 */
export function cropAdvice(
  crops: readonly string[],
  data: AgricultureResponse,
): CropAdvice[] {
  const w = data.windows;
  if (!w) return [];
  const heatHigh = data.risks?.heat.level === "high";
  const frost = data.risks?.frost.level !== "none" ? data.risks?.frost : null;
  const wetHours = forecastDays(data.daily)
    .slice(0, 3)
    .reduce((n, d) => n + (d.leafWetHours ?? 0), 0);
  const balance = data.waterBalance?.balanceNext7dMm ?? null;

  const tipsFor = (id: string): string[] => {
    const t: string[] = [];
    switch (id) {
      case "crop-farming":
      case "planting":
        t.push(`Planting: ${w.plant.label}. ${w.plant.detail}`);
        if (data.gdd?.next7d != null)
          t.push(
            `About ${Math.round(data.gdd.next7d)} growing degree days this week; medium-season maize needs roughly 1,300–1,500 from planting.`,
          );
        if (heatHigh)
          t.push(
            "Heat stress this week hurts crops at flowering: irrigate early in the day if you can.",
          );
        break;
      case "tobacco-farming":
        if (wetHours >= 12)
          t.push(
            `${wetHours} leaf-wet hours over 3 days favour leaf disease: scout and spray in the next dry window.`,
          );
        t.push(`Reaping and curing: ${w.harvest.label}. ${w.harvest.detail}`);
        t.push(`Spraying: ${w.spray.label}.`);
        break;
      case "cotton-farming":
        t.push(
          `Picking: ${w.harvest.label}. Rain on open bolls lowers the grade.`,
        );
        t.push(`Pest control: ${w.spray.label}.`);
        break;
      case "horticulture":
      case "gardening":
        t.push(`Water: ${w.irrigate.label}. ${w.irrigate.detail}`);
        if (frost) t.push(frost.detail);
        break;
      case "irrigation":
        t.push(`${w.irrigate.label}. ${w.irrigate.detail}`);
        if (balance !== null)
          t.push(`7-day balance ${formatBalance(balance)} (rain − ET₀).`);
        break;
      case "harvest":
        t.push(`${w.harvest.label}. ${w.harvest.detail}`);
        break;
      case "livestock":
        if (data.risks) t.push(data.risks.heat.detail);
        if (balance !== null && balance < -10)
          t.push("Dry week ahead: check water points and grazing reserves.");
        else if ((data.rain?.rainyDaysNext7 ?? 0) >= 4)
          t.push(
            "Several wet days ahead raise tick pressure: keep to the dipping schedule.",
          );
        break;
      case "forestry":
        if (balance !== null && balance < -10)
          t.push(
            "Dry, high-demand week: fire risk rises; keep firebreaks clear.",
          );
        break;
      case "beekeeping":
        t.push(
          (data.rain?.rainyDaysNext7 ?? 0) >= 4
            ? "Several wet days ahead limit foraging: check hive stores."
            : "Mostly dry week: good foraging days for the colonies.",
        );
        break;
      case "aquaculture":
        if (heatHigh)
          t.push(
            "Hot days lower dissolved oxygen: feed in the cool morning and aerate.",
          );
        break;
    }
    return t.slice(0, 3);
  };

  return crops
    .map((id) => ({ id, label: cropLabel(id), tips: tipsFor(id) }))
    .filter((c) => c.tips.length > 0);
}

// ---------------------------------------------------------------------------
// History vs normals
// ---------------------------------------------------------------------------

interface HistoryDocLike {
  date?: string;
  daily?: {
    temperature_2m_max?: (number | null)[];
    temperature_2m_min?: (number | null)[];
    precipitation_sum?: (number | null)[];
  };
}

export interface HistorySummary {
  days: number;
  rainMm: number | null;
  meanHigh: number | null;
  meanLow: number | null;
}

const mean = (xs: number[]): number | null =>
  xs.length
    ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10
    : null;

/** Totals and means over the recorded `/v1/history` days. */
export function summarizeHistory(
  docs: readonly HistoryDocLike[],
): HistorySummary {
  const highs: number[] = [];
  const lows: number[] = [];
  const rain: number[] = [];
  for (const d of docs) {
    const hi = d.daily?.temperature_2m_max?.[0];
    const lo = d.daily?.temperature_2m_min?.[0];
    const r = d.daily?.precipitation_sum?.[0];
    if (typeof hi === "number") highs.push(hi);
    if (typeof lo === "number") lows.push(lo);
    if (typeof r === "number") rain.push(r);
  }
  return {
    days: docs.length,
    rainMm: rain.length
      ? Math.round(rain.reduce((a, b) => a + b, 0) * 10) / 10
      : null,
    meanHigh: mean(highs),
    meanLow: mean(lows),
  };
}

/** "+1.4°C" / "−0.6°C" / "0.0°C" anomaly against a normal, or null. */
export function formatAnomaly(
  value: number | null | undefined,
  normal: number | null | undefined,
): string | null {
  if (value == null || normal == null) return null;
  const diff = Math.round((value - normal) * 10) / 10;
  if (diff === 0) return "0.0°C";
  return `${diff > 0 ? "+" : "−"}${Math.abs(diff).toFixed(1)}°C`;
}

/** 1-based month at the location (its UTC offset), never the viewer's clock. */
export function locationMonth(
  utcOffsetSeconds: number | null | undefined,
  nowMs = Date.now(),
): number {
  return new Date(nowMs + (utcOffsetSeconds ?? 0) * 1000).getUTCMonth() + 1;
}
