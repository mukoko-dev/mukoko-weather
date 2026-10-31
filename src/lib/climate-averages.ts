/**
 * Climate averages for the Averages detail: the twelve monthly normals
 * (`/v1/normals/monthly`, ERA5 1991-2020) set against the coming week's
 * forecast and, where the place has a recorded history, the last days of
 * observations. Pure functions: no network, no clock, never throw, and a
 * missing value stays `null` (it is never turned into zero).
 *
 * A comparison is made only when both sides exist, and the sentence says what
 * was compared (the days, the period), so a reader can see the basis.
 */

import type { DailyWeather } from "./weather";

export interface MonthlyNormal {
  /** 1 (January) to 12. */
  month: number;
  meanTempC: number | null;
  meanHighC: number | null;
  meanLowC: number | null;
  /** Mean rainfall for the whole month, mm. */
  precipMm: number | null;
  /** Mean number of days with at least 1 mm. */
  rainyDays: number | null;
}

export interface ParsedMonthlyNormals {
  months: MonthlyNormal[];
  period: string;
  source: string;
}

export const MONTH_LABELS = [
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

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** The Worker's answer as twelve months, or null when it is not usable. */
export function parseMonthlyNormals(
  json: unknown,
): ParsedMonthlyNormals | null {
  if (typeof json !== "object" || json === null) return null;
  const body = json as Record<string, unknown>;
  if (body.available !== true || !Array.isArray(body.months)) return null;
  if (body.months.length !== 12) return null;
  const months: MonthlyNormal[] = [];
  for (let i = 0; i < 12; i++) {
    const m = body.months[i];
    if (typeof m !== "object" || m === null) return null;
    const row = m as Record<string, unknown>;
    months.push({
      month: i + 1,
      meanTempC: num(row.meanTempC),
      meanHighC: num(row.meanHighC),
      meanLowC: num(row.meanLowC),
      precipMm: num(row.precipMm),
      rainyDays: num(row.rainyDays),
    });
  }
  return {
    months,
    period: typeof body.period === "string" ? body.period : "1991–2020",
    source:
      typeof body.source === "string" ? body.source : "ERA5 via Open-Meteo",
  };
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** Month index 0-11 of a `YYYY-MM-DD` (or ISO) string, or null. */
export function monthIndexOf(iso: string | undefined | null): number | null {
  const m = typeof iso === "string" ? DATE_RE.exec(iso) : null;
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? month - 1 : null;
}

/** Days in the calendar month of a `YYYY-MM-DD` string (28 to 31), or null. */
export function daysInMonthOf(iso: string | undefined | null): number | null {
  const m = typeof iso === "string" ? DATE_RE.exec(iso) : null;
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
}

export interface MonthlyRow {
  label: string;
  meanHighC: number | null;
  meanLowC: number | null;
  precipMm: number | null;
  rainyDays: number | null;
}

/** Chart and table rows, January first. */
export function monthlyRows(months: readonly MonthlyNormal[]): MonthlyRow[] {
  return months.map((m) => ({
    label: MONTH_LABELS[m.month - 1],
    meanHighC: m.meanHighC,
    meanLowC: m.meanLowC,
    precipMm: m.precipMm,
    rainyDays: m.rainyDays,
  }));
}

export interface Comparison {
  /** What the number is, e.g. "Next 7 days". */
  basis: string;
  /** The observed or forecast value (temperature in °C, rainfall in mm). */
  value: number | null;
  /** The normal over the same days. */
  normal: number | null;
  /** value minus normal, rounded; null when either side is missing. */
  delta: number | null;
  sentence: string;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;

function temperatureSentence(
  basis: string,
  value: number,
  normal: number,
): string {
  const delta = Math.round(value - normal);
  const what = `${basis}: highs average ${Math.round(value)}° against a normal ${Math.round(normal)}°.`;
  if (delta === 0) return `${what} Close to the average.`;
  return `${what} ${Math.abs(delta)}° ${delta > 0 ? "above" : "below"} average.`;
}

function rainSentence(basis: string, value: number, normal: number): string {
  const what = `${basis}: ${r1(value)} mm against about ${r1(normal)} mm normally over the same days.`;
  if (normal < 1) {
    return value < 1
      ? `${what} Dry, as usual for this time of year.`
      : `${what} Wetter than usual.`;
  }
  const ratio = value / normal;
  if (ratio < 0.8) return `${what} Drier than average.`;
  if (ratio > 1.2) return `${what} Wetter than average.`;
  return `${what} Close to the average.`;
}

function build(
  basis: string,
  highs: number[],
  rain: number[],
  normal: MonthlyNormal | undefined,
  daysInMonth: number | null,
  kind: "temperature" | "precipitation",
): Comparison {
  const days = Math.max(highs.length, rain.length);
  if (kind === "temperature") {
    const value = highs.length ? r1(mean(highs)) : null;
    const nv = normal?.meanHighC ?? null;
    const delta = value !== null && nv !== null ? Math.round(value - nv) : null;
    return {
      basis,
      value,
      normal: nv,
      delta,
      sentence:
        value !== null && nv !== null
          ? temperatureSentence(basis, value, nv)
          : `${basis}: no average is available to compare with.`,
    };
  }
  const value = rain.length ? r1(rain.reduce((a, b) => a + b, 0)) : null;
  const perDay =
    normal?.precipMm != null && daysInMonth
      ? normal.precipMm / daysInMonth
      : null;
  const nv = perDay !== null && days > 0 ? r1(perDay * days) : null;
  const delta = value !== null && nv !== null ? r1(value - nv) : null;
  return {
    basis,
    value,
    normal: nv,
    delta,
    sentence:
      value !== null && nv !== null
        ? rainSentence(basis, value, nv)
        : `${basis}: no average is available to compare with.`,
  };
}

/**
 * The coming days of the forecast (up to 7, starting with the first daily
 * entry) against the normals of that entry's calendar month, rainfall
 * prorated to the number of days compared.
 */
export function forecastComparison(
  daily: DailyWeather | undefined,
  months: readonly MonthlyNormal[],
  kind: "temperature" | "precipitation",
): Comparison {
  const times = daily?.time ?? [];
  const idx = monthIndexOf(times[0]);
  const n = Math.min(7, times.length);
  const highs: number[] = [];
  const rain: number[] = [];
  for (let i = 0; i < n; i++) {
    const h = num(daily?.temperature_2m_max?.[i]);
    if (h !== null) highs.push(h);
    const p = num(daily?.precipitation_sum?.[i]);
    if (p !== null) rain.push(p);
  }
  return build(
    n > 0 ? `Next ${n} days` : "Next days",
    highs,
    rain,
    idx === null ? undefined : months[idx],
    daysInMonthOf(times[0]),
    kind,
  );
}

export interface RecentDay {
  date: string;
  highC: number | null;
  precipMm: number | null;
}

/** Fewest recorded days worth comparing with an average. */
export const MIN_RECENT_DAYS = 7;

/**
 * Recorded days against the normals of the latest day's calendar month. Needs
 * at least `MIN_RECENT_DAYS`; fewer is "not enough record yet", not a trend.
 */
export function recentComparison(
  days: readonly RecentDay[],
  months: readonly MonthlyNormal[],
  kind: "temperature" | "precipitation",
): Comparison | null {
  if (days.length < MIN_RECENT_DAYS) return null;
  const latest = days[days.length - 1].date;
  const idx = monthIndexOf(latest);
  const highs = days.flatMap((d) => (d.highC === null ? [] : [d.highC]));
  const rain = days.flatMap((d) => (d.precipMm === null ? [] : [d.precipMm]));
  return build(
    `Last ${days.length} recorded days`,
    highs,
    rain,
    idx === null ? undefined : months[idx],
    daysInMonthOf(latest),
    kind,
  );
}

/**
 * Recorded days from the Worker's `/v1/history` body (`{data: docs}`), oldest
 * first. Only the daily block counts: a document's `current` is one moment, not
 * the day's high or total, so it is never used as a stand-in.
 */
export function recentDaysFromHistory(json: unknown): RecentDay[] {
  const docs =
    typeof json === "object" && json !== null
      ? (json as { data?: unknown }).data
      : null;
  if (!Array.isArray(docs)) return [];
  const out: RecentDay[] = [];
  for (const doc of docs) {
    if (typeof doc !== "object" || doc === null) continue;
    const d = doc as {
      date?: unknown;
      daily?: { temperature_2m_max?: unknown[]; precipitation_sum?: unknown[] };
    };
    if (typeof d.date !== "string" || !DATE_RE.test(d.date)) continue;
    out.push({
      date: d.date.slice(0, 10),
      highC: num(d.daily?.temperature_2m_max?.[0]),
      precipMm: num(d.daily?.precipitation_sum?.[0]),
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
