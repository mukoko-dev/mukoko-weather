/**
 * Community Lane — pure data logic behind the 24-hour activity lane.
 *
 * The lane is a fixed 24-hour window: 12 hours back (so community reports,
 * which are past events, have somewhere to sit) and 12 hours forward. Each
 * hour is scored by the SAME database rules the activity cards use
 * (resolveRule + hourInsights + evaluateRule from activity-feasibility /
 * suitability), so the lane and the cards can never disagree.
 *
 * Time zone: cells are real instants (epoch ms), but every hour boundary and
 * every "HH:00" label is read in the LOCATION's offset (`utc_offset_seconds`
 * on the payload), never the viewer's clock — someone in Toronto looking at
 * Harare sees Harare's hours. Omitting the offset falls back to the viewer's
 * clock (payloads that predate the field).
 *
 * No React or DOM imports here — everything is unit-testable.
 */

import type { Activity } from "./activities";
import type { HourlyWeather } from "./weather";
import type { SuitabilityRuleDoc } from "./db";
import { evaluateRule } from "./suitability";
import {
  LEVEL_SCORES,
  hourInsights,
  resolveRule,
  type SuitabilityLevel,
} from "./activity-feasibility";
import {
  currentWallHourMs,
  instantMs,
  resolveOffsetSeconds,
  wallHourLabel,
} from "./location-time";

export const LANE_HOURS = 24;
export const LANE_PAST_HOURS = 12;
export const LANE_MAX_ACTIVITIES = 4;
/** Lane cells are this far apart when a pin would otherwise overlap a neighbour. */
export const PIN_MIN_GAP_CELLS = 4;
export const PIN_MAX_TIERS = 3;

const HOUR_MS = 3_600_000;

export type LaneLevel = SuitabilityLevel;

export const LEVEL_WORDS: Record<LaneLevel, string> = {
  excellent: "Excellent",
  good: "Good",
  fair: "Fair",
  poor: "Poor",
};

export interface LaneCell {
  /** 0 = 12 hours ago, 12 = the current hour, 23 = 11 hours ahead */
  index: number;
  /** Start of the hour, epoch ms */
  at: number;
  /** null when the forecast has no data for this hour or no rule applies */
  level: LaneLevel | null;
  isPast: boolean;
}

export interface LaneRun {
  level: LaneLevel;
  /** inclusive cell index */
  start: number;
  /** exclusive cell index */
  end: number;
}

export interface BestWindow {
  start: number;
  end: number;
  level: LaneLevel;
  avgScore: number;
}

export interface ReportLike {
  id: string;
  reportType: string;
  reportedAt: string;
}

export interface PinGroup {
  /** lane cell index */
  index: number;
  total: number;
  /** report types in this hour, most frequent first */
  counts: { type: string; count: number }[];
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** "HH:00" at the location for an hour starting at instant `ms`. */
export function formatLaneHour(
  ms: number,
  offsetSeconds?: number | null,
): string {
  const offset = resolveOffsetSeconds(offsetSeconds, new Date(ms));
  return wallHourLabel(ms + offset * 1000);
}

/**
 * Start of the location's current hour minus LANE_PAST_HOURS, epoch ms.
 * Floors in the location's wall clock, so half-hour zones (India, Myanmar)
 * still get cells that start on their own hour.
 */
export function laneBaseMs(now: Date, offsetSeconds?: number | null): number {
  const offset = resolveOffsetSeconds(offsetSeconds, now);
  return (
    currentWallHourMs(offset, now) - offset * 1000 - LANE_PAST_HOURS * HOUR_MS
  );
}

/** Start of lane cell `index`, epoch ms. Independent of forecast data. */
export function laneCellMs(
  now: Date,
  index: number,
  offsetSeconds?: number | null,
): number {
  return laneBaseMs(now, offsetSeconds) + index * HOUR_MS;
}

/**
 * Score every cell of the lane for one activity. Cells whose hour is absent
 * from the forecast (e.g. the past 12 hours when the forecast starts later)
 * come back with level null, which renders as "no data", never as a rating.
 */
export function buildLaneCells(
  activity: Pick<Activity, "id" | "category">,
  hourly: HourlyWeather | undefined,
  rules: Map<string, SuitabilityRuleDoc>,
  now: Date = new Date(),
  offsetSeconds?: number | null,
): LaneCell[] {
  const offset = resolveOffsetSeconds(offsetSeconds, now);
  const base = laneBaseMs(now, offset);
  const rule = resolveRule(activity, rules);

  // Naive local forecast strings ("2026-10-08T14:00") are wall time at the
  // location; zoned ones are instants. instantMs() maps both to real epoch ms.
  const indexByMs = new Map<number, number>();
  hourly?.time?.forEach((t, i) => {
    const ms = instantMs(t, offset);
    if (ms !== null) indexByMs.set(ms, i);
  });

  return Array.from({ length: LANE_HOURS }, (_, i) => {
    const at = base + i * HOUR_MS;
    const idx = indexByMs.get(at);
    let level: LaneLevel | null = null;
    if (rule && hourly && idx !== undefined) {
      level = evaluateRule(rule, hourInsights(hourly, idx)).level;
    }
    return { index: i, at, level, isPast: i < LANE_PAST_HOURS };
  });
}

/** Consecutive runs of the same rating, skipping no-data cells. */
export function laneRuns(cells: LaneCell[]): LaneRun[] {
  const runs: LaneRun[] = [];
  for (const cell of cells) {
    if (cell.level === null) continue;
    const last = runs[runs.length - 1];
    if (last && last.level === cell.level && last.end === cell.index) {
      last.end = cell.index + 1;
    } else {
      runs.push({ level: cell.level, start: cell.index, end: cell.index + 1 });
    }
  }
  return runs;
}

/**
 * The best window to plan around: the longest contiguous stretch of
 * good-or-better hours from the current hour onwards (excellent and good
 * hours count together, so a window is "when it is workable"). Ties go to
 * the higher average score. Past hours are never proposed as a window.
 */
export function bestWindow(cells: LaneCell[]): BestWindow | null {
  const future = cells.filter((c) => !c.isPast);
  let best: BestWindow | null = null;
  let run: LaneCell[] = [];

  const consider = () => {
    if (run.length === 0) return;
    const avgScore =
      run.reduce((sum, c) => sum + LEVEL_SCORES[c.level!], 0) / run.length;
    const start = run[0].index;
    const end = run[run.length - 1].index + 1;
    const length = end - start;
    const bestLength = best ? best.end - best.start : 0;
    if (
      !best ||
      length > bestLength ||
      (length === bestLength && avgScore > best.avgScore)
    ) {
      const level: LaneLevel = run.every((c) => c.level === "excellent")
        ? "excellent"
        : "good";
      best = { start, end, level, avgScore };
    }
    run = [];
  };

  for (const cell of future) {
    if (cell.level === "good" || cell.level === "excellent") {
      run.push(cell);
    } else {
      consider();
    }
  }
  consider();
  return best;
}

/** Location-local "HH:00 to HH:00" for a cell range. */
function rangeLabel(
  cells: LaneCell[],
  start: number,
  end: number,
  offsetSeconds?: number | null,
): string {
  return `${formatLaneHour(cells[start].at, offsetSeconds)} to ${formatLaneHour(
    cells[end - 1].at + HOUR_MS,
    offsetSeconds,
  )}`;
}

/**
 * Window wording for a best window. A window that runs to the end of the
 * lane is open-ended ("from 18:00"), because the lane stops at 11 hours
 * ahead and the window may well continue past it.
 */
export function bestWindowText(
  cells: LaneCell[],
  best: BestWindow,
  separator = "–",
  offsetSeconds?: number | null,
): string {
  if (best.end >= cells.length) {
    return `from ${formatLaneHour(cells[best.start].at, offsetSeconds)}`;
  }
  return `${formatLaneHour(cells[best.start].at, offsetSeconds)}${separator}${formatLaneHour(
    cells[best.end - 1].at + HOUR_MS,
    offsetSeconds,
  )}`;
}

/**
 * One screen-reader sentence per lane, so the rating is never conveyed by
 * colour alone. Example: "Farming: Excellent 06:00 to 10:00, Poor 14:00 to
 * 18:00. Best window 06:00 to 10:00."
 */
export function laneSummary(
  label: string,
  cells: LaneCell[],
  offsetSeconds?: number | null,
): string {
  if (cells.every((c) => c.level === null)) {
    return `${label}: no forecast for this activity yet.`;
  }
  const parts = laneRuns(cells).map(
    (run) =>
      `${LEVEL_WORDS[run.level]} ${rangeLabel(cells, run.start, run.end, offsetSeconds)}`,
  );
  const best = bestWindow(cells);
  const bestText = best
    ? `Best window ${bestWindowText(cells, best, " to ", offsetSeconds)}.`
    : "No good window in the next 12 hours.";
  return `${label}: ${parts.join(", ")}. ${bestText}`;
}

/**
 * Group reports into one pin per lane hour. Reports outside the 24-hour
 * window are dropped.
 */
export function groupReportsByHour(
  reports: ReportLike[],
  now: Date = new Date(),
  offsetSeconds?: number | null,
): Map<number, PinGroup> {
  const base = laneBaseMs(now, offsetSeconds);
  const byHour = new Map<number, Map<string, number>>();
  for (const report of reports) {
    const ms = new Date(report.reportedAt).getTime();
    if (Number.isNaN(ms)) continue;
    const index = Math.floor((ms - base) / HOUR_MS);
    if (index < 0 || index >= LANE_HOURS) continue;
    const types = byHour.get(index) ?? new Map<string, number>();
    types.set(report.reportType, (types.get(report.reportType) ?? 0) + 1);
    byHour.set(index, types);
  }

  const groups = new Map<number, PinGroup>();
  for (const [index, types] of byHour) {
    const counts = [...types.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
    const total = counts.reduce((sum, c) => sum + c.count, 0);
    groups.set(index, { index, total, counts });
  }
  return groups;
}

/**
 * Stagger pins into tiers so neighbouring pins never overlap. Greedy: each
 * pin takes the first tier with enough room since its last pin. Pins that
 * still do not fit share the last tier.
 */
export function assignPinTiers(
  indices: number[],
  minGap = PIN_MIN_GAP_CELLS,
  maxTiers = PIN_MAX_TIERS,
): Map<number, number> {
  const lastInTier: number[] = [];
  const tiers = new Map<number, number>();
  for (const index of [...indices].sort((a, b) => a - b)) {
    let tier = lastInTier.findIndex(
      (last) => last === undefined || index - last >= minGap,
    );
    if (tier === -1) {
      tier = lastInTier.length < maxTiers ? lastInTier.length : maxTiers - 1;
    }
    lastInTier[tier] = index;
    tiers.set(index, tier);
  }
  return tiers;
}
