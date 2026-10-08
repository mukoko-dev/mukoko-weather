"use client";

import { useEffect, useId, useMemo, useState } from "react";
import {
  CATEGORY_STYLES,
  getActivityById,
  type Activity,
} from "@/lib/activities";
import { fetchSuitabilityRules } from "@/lib/suitability-cache";
import { getReportTypeInfo } from "@/lib/report-types";
import { useAppStore } from "@/lib/store";
import type { WeatherData } from "@/lib/weather";
import { weatherOffsetSeconds } from "@/lib/location-time";
import type { SuitabilityRuleDoc } from "@/lib/db";
import {
  LANE_HOURS,
  LANE_MAX_ACTIVITIES,
  LANE_PAST_HOURS,
  LEVEL_WORDS,
  assignPinTiers,
  bestWindow,
  bestWindowText,
  buildLaneCells,
  formatLaneHour,
  groupReportsByHour,
  laneCellMs,
  laneSummary,
  type LaneCell,
  type LaneLevel,
  type PinGroup,
  type ReportLike,
} from "@/lib/community-lane";

export interface CommunityLaneProps {
  /** Location slug — keys the community reports feed. */
  slug: string;
  /** Reserved for coordinate-based report lookups; the lane itself reads `weather`. */
  lat: number;
  lon: number;
  weather: WeatherData;
  /** Activity ids from the user's My Weather selection, in display order. */
  selectedActivities: string[];
}

/**
 * Fill per mineral, per rating. Mineral follows the activity category
 * (CATEGORY_STYLES), and the rating is carried by intensity AND bar height,
 * so the rating never depends on colour alone. Classes are spelled out
 * in full so Tailwind generates them.
 */
const LANE_FILL: Record<string, Record<LaneLevel, string>> = {
  farming: {
    excellent: "bg-mineral-malachite",
    good: "bg-mineral-malachite/70",
    fair: "bg-mineral-malachite/45",
    poor: "bg-mineral-malachite/25",
  },
  mining: {
    excellent: "bg-mineral-terracotta",
    good: "bg-mineral-terracotta/70",
    fair: "bg-mineral-terracotta/45",
    poor: "bg-mineral-terracotta/25",
  },
  travel: {
    excellent: "bg-mineral-cobalt",
    good: "bg-mineral-cobalt/70",
    fair: "bg-mineral-cobalt/45",
    poor: "bg-mineral-cobalt/25",
  },
  tourism: {
    excellent: "bg-mineral-tanzanite",
    good: "bg-mineral-tanzanite/70",
    fair: "bg-mineral-tanzanite/45",
    poor: "bg-mineral-tanzanite/25",
  },
  sports: {
    excellent: "bg-mineral-gold",
    good: "bg-mineral-gold/70",
    fair: "bg-mineral-gold/45",
    poor: "bg-mineral-gold/25",
  },
  casual: {
    excellent: "bg-mineral-copper",
    good: "bg-mineral-copper/70",
    fair: "bg-mineral-copper/45",
    poor: "bg-mineral-copper/25",
  },
};

const LEVEL_HEIGHT: Record<LaneLevel, string> = {
  excellent: "h-full",
  good: "h-3/4",
  fair: "h-1/2",
  poor: "h-1/4",
};

const LEGEND_HEIGHT: Record<LaneLevel, string> = {
  excellent: "h-5",
  good: "h-4",
  fair: "h-3",
  poor: "h-2",
};

/** Fixed 24-column grid shared by the axis, the pins and every lane. */
const GRID_24 = "grid grid-cols-[repeat(24,minmax(0,1fr))]";

/** Pin rows rendered at most; matches PIN_MAX_TIERS in the lib. */
const PIN_TIER_ROWS = 3;

function fillFor(category: string, level: LaneLevel): string {
  return (LANE_FILL[category] ?? LANE_FILL.casual)[level];
}

function pinAlignment(index: number): string {
  if (index === 0) return "left-0";
  if (index === LANE_HOURS - 1) return "right-0";
  return "left-1/2 -translate-x-1/2";
}

function countLine(count: number, label: string): string {
  return `${count} ${count === 1 ? "report" : "reports"}: ${label.toLowerCase()}`;
}

export function CommunityLane({
  slug,
  weather,
  selectedActivities,
}: CommunityLaneProps) {
  const headingId = useId();
  const panelId = useId();
  const openMyWeather = useAppStore((s) => s.openMyWeather);

  const [rules, setRules] = useState<Map<string, SuitabilityRuleDoc> | null>(
    null,
  );
  const [reports, setReports] = useState<ReportLike[] | null>(null);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [now] = useState(() => new Date());
  // Hours and labels are read in the LOCATION's time zone, not the viewer's.
  const offset = weatherOffsetSeconds(weather, now);

  const activities: Activity[] = useMemo(
    () =>
      selectedActivities
        .map((id) => getActivityById(id))
        .filter((a): a is Activity => a !== undefined)
        .slice(0, LANE_MAX_ACTIVITIES),
    [selectedActivities],
  );

  useEffect(() => {
    if (activities.length === 0) return;
    let alive = true;
    fetchSuitabilityRules()
      .then((list) => {
        if (alive) setRules(new Map(list.map((r) => [r.key, r])));
      })
      .catch(() => {
        if (alive) setRules(new Map());
      });
    return () => {
      alive = false;
    };
    // Rules are global; they only need loading once per mount.
  }, [activities.length]);

  useEffect(() => {
    if (!slug || activities.length === 0) return;
    let alive = true;
    fetch(`/api/py/reports?location=${encodeURIComponent(slug)}&hours=24`)
      .then((res) => (res.ok ? res.json() : { reports: [] }))
      .then((data) => {
        if (alive) setReports(Array.isArray(data?.reports) ? data.reports : []);
      })
      .catch(() => {
        // Reports are supplementary; the lane still works without them.
        if (alive) setReports([]);
      });
    return () => {
      alive = false;
    };
  }, [slug, activities.length]);

  const lanes = useMemo(
    () =>
      rules
        ? activities.map((activity) => {
            const cells = buildLaneCells(
              activity,
              weather.hourly,
              rules,
              now,
              offset,
            );
            return { activity, cells, best: bestWindow(cells) };
          })
        : null,
    [activities, rules, weather.hourly, now, offset],
  );

  const pinGroups = useMemo(
    () => groupReportsByHour(reports ?? [], now, offset),
    [reports, now, offset],
  );
  const pinTiers = useMemo(
    () => assignPinTiers([...pinGroups.keys()]),
    [pinGroups],
  );
  const tierCount = pinTiers.size
    ? Math.min(PIN_TIER_ROWS, Math.max(...pinTiers.values()) + 1)
    : 0;
  const openGroup: PinGroup | undefined =
    openIndex !== null ? pinGroups.get(openIndex) : undefined;

  if (activities.length === 0) {
    return (
      <section aria-labelledby={headingId} className="baobab space-y-3">
        <h2 id={headingId} className="giraffe">
          Community lane
        </h2>
        <p className="gazelle">
          Choose the activities you care about and this lane shows, hour by
          hour, when each one is workable over the next day, with what
          neighbours report along the way.
        </p>
        <button
          type="button"
          onClick={() => openMyWeather("activities")}
          className="kudu min-h-[var(--touch-target-min)]"
        >
          Pick activities
        </button>
      </section>
    );
  }

  return (
    <section aria-labelledby={headingId} className="baobab space-y-4">
      <div className="space-y-1">
        <h2 id={headingId} className="giraffe">
          Community lane
        </h2>
        <p className="dove">
          12 hours back and 12 ahead. Bars are taller for better hours.
        </p>
      </div>

      {/* Pins, panel and axis share the lanes' left inset so all 24 columns line up. */}
      <div className="space-y-1 border-l-4 border-transparent pl-3">
        {/* Report pins, one per hour, staggered into tiers so none overlap. */}
        {tierCount > 0 && (
          <div className="space-y-0" aria-label="Community reports by hour">
            {Array.from({ length: tierCount }, (_, tier) => (
              <div
                key={tier}
                className={`${GRID_24} h-[var(--touch-target-min)]`}
              >
                {Array.from({ length: LANE_HOURS }, (_, index) => {
                  const group = pinGroups.get(index);
                  if (!group || pinTiers.get(index) !== tier) {
                    return <div key={index} aria-hidden="true" />;
                  }
                  const lead = group.counts[0];
                  const LeadIcon = getReportTypeInfo(lead.type)?.icon;
                  const expanded = openIndex === index;
                  const lines = group.counts.map((c) =>
                    countLine(
                      c.count,
                      getReportTypeInfo(c.type)?.label ?? c.type,
                    ),
                  );
                  return (
                    <div key={index} className="relative">
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-controls={panelId}
                        aria-label={`${formatLaneHour(laneCellMs(now, index, offset), offset)}: ${lines.join(", ")}`}
                        onClick={() => setOpenIndex(expanded ? null : index)}
                        className={`absolute top-0 ${pinAlignment(index)} z-10 flex min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)] items-center justify-center rounded-full`}
                      >
                        <span
                          className={`flex size-8 items-center justify-center rounded-full bg-mineral-copper text-mineral-copper-fg shadow-sm ${expanded ? "ring-2 ring-text-primary" : ""}`}
                        >
                          {LeadIcon && (
                            <span aria-hidden="true">
                              <LeadIcon size={18} />
                            </span>
                          )}
                        </span>
                        <span
                          aria-hidden="true"
                          className="absolute right-0.5 top-1 rounded-full bg-text-primary px-1 text-xs font-bold text-surface-card"
                        >
                          {group.total}
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {openGroup && (
          <div
            id={panelId}
            role="region"
            aria-label={`Reports at ${formatLaneHour(laneCellMs(now, openGroup.index, offset), offset)}`}
            className="acacia space-y-2"
          >
            <p className="text-base font-semibold text-text-primary">
              Reports at{" "}
              {formatLaneHour(laneCellMs(now, openGroup.index, offset), offset)}
            </p>
            <ul className="space-y-1">
              {openGroup.counts.map((c) => (
                <li key={c.type} className="text-base text-text-secondary">
                  {countLine(
                    c.count,
                    getReportTypeInfo(c.type)?.label ?? c.type,
                  )}
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => setOpenIndex(null)}
              className="impala-sm min-h-[var(--touch-target-min)]"
            >
              Close
            </button>
          </div>
        )}

        {/* Time axis: a tick every three hours, the current hour marked. */}
        <div aria-hidden="true" className="space-y-1">
          <div className={`${GRID_24} gap-px`}>
            {Array.from({ length: LANE_HOURS }, (_, i) => {
              const label =
                i === LANE_PAST_HOURS
                  ? "Now"
                  : formatLaneHour(laneCellMs(now, i, offset), offset);
              return (
                <div key={i} className="relative h-5">
                  {i % 3 === 0 && (
                    <span
                      className={`absolute left-0 whitespace-nowrap font-mono text-xs ${i === LANE_PAST_HOURS ? "font-bold text-text-primary" : "text-text-tertiary"}`}
                    >
                      {label}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {activities.length > 0 && rules === null && (
        <p role="status" className="dove">
          <span className="sr-only">Loading the lane</span>
          Loading forecast…
        </p>
      )}

      {/* One lane per activity. */}
      <div className="space-y-5">
        {(
          lanes ??
          activities.map((activity) => ({ activity, cells: null, best: null }))
        ).map((lane) => {
          const style =
            CATEGORY_STYLES[lane.activity.category] ?? CATEGORY_STYLES.casual;
          const labelId = `${headingId}-${lane.activity.id}-label`;
          const summaryId = `${headingId}-${lane.activity.id}-summary`;
          const cells: LaneCell[] | null = lane.cells;
          const summary = cells
            ? laneSummary(lane.activity.label, cells, offset)
            : `${lane.activity.label}: loading forecast.`;
          return (
            <div
              key={lane.activity.id}
              role="group"
              aria-labelledby={labelId}
              aria-describedby={summaryId}
              className={`space-y-2 border-l-4 pl-3 ${style.borderAccent ?? ""}`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <h3
                  id={labelId}
                  className="text-base font-semibold text-text-primary"
                >
                  {lane.activity.label}
                </h3>
                <p
                  aria-hidden="true"
                  className={`text-base font-medium ${style.text}`}
                >
                  {lane.best && cells
                    ? `Best: ${bestWindowText(cells, lane.best, "–", offset)}`
                    : cells
                      ? "No good window"
                      : ""}
                </p>
              </div>
              <p id={summaryId} className="sr-only">
                {summary}
              </p>
              <div
                aria-hidden="true"
                className={`${GRID_24} h-10 items-end gap-px`}
              >
                {(
                  cells ??
                  Array.from({ length: LANE_HOURS }, (_, i) => ({
                    index: i,
                    at: 0,
                    level: null,
                    isPast: i < LANE_PAST_HOURS,
                  }))
                ).map((cell) => (
                  <div
                    key={cell.index}
                    className={`flex h-full items-end ${cell.index === LANE_PAST_HOURS ? "border-l-2 border-text-primary" : ""} ${cell.isPast ? "opacity-60" : ""}`}
                  >
                    <span
                      className={`w-full rounded-sm ${
                        cell.level
                          ? `${fillFor(lane.activity.category, cell.level)} ${LEVEL_HEIGHT[cell.level]}`
                          : "h-1/4 bg-surface-dim"
                      }`}
                    />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend: height and intensity, neutral so it is not one mineral. */}
      <ul
        aria-label="How to read the lane"
        className="flex flex-wrap items-end gap-x-4 gap-y-2"
      >
        {(["excellent", "good", "fair", "poor"] as LaneLevel[]).map((level) => (
          <li key={level} className="flex items-end gap-1.5">
            <span
              aria-hidden="true"
              className={`inline-block w-3 rounded-sm bg-text-secondary ${LEGEND_HEIGHT[level]}`}
            />
            <span className="text-base text-text-secondary">
              {LEVEL_WORDS[level]}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
