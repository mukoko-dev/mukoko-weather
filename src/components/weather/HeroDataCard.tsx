"use client";

import { useMemo } from "react";
import { useAppStore } from "@/lib/store";
import {
  HERO_STRIP_HOURS,
  formatDegrees,
  heroHourStrip,
  heroReadings,
} from "@/lib/hero-card";
import type { CurrentWeather, HourlyWeather } from "@/lib/weather";
import { HeroDayCurve, type HeroCurveSource } from "./HeroDayCurve";
import {
  HERO_CAPTION,
  HERO_CARD_CLASS,
  HERO_FIGURE,
  HERO_READINGS_CLASS,
  HERO_READING_CLASS,
  HERO_ROW_CLASS,
  HERO_STRIP_CELL_CLASS,
  HERO_STRIP_CLASS,
} from "./hero-card-classes";

/** The activity the visitor picked, as the hero's clause line reads it. */
export interface HeroActivityLine {
  label: string;
  /** Static dot class for the activity's category. */
  dot: string;
  /** "good until 15:00". */
  clause: string;
}

interface Props {
  current: CurrentWeather;
  placeName: string;
  hourly?: HourlyWeather;
  /** The place's UTC offset: every hour here is read in the PLACE's time. */
  utcOffsetSeconds?: number;
  /** The place's clock; null until the hero has mounted (it is client-only). */
  now: Date | null;
  /** The visitor has activities selected. */
  hasSelection: boolean;
  /** The clause for the first selected activity with a readable series. */
  activityLine: HeroActivityLine | null;
}

/**
 * The hero's data card: the ONE surface under the open sky. It holds what you
 * scan or tap: the next five hours, the 24-hour curve, Feels / Wind / UV, and
 * the activities row last. Every part leaves itself out when its data is
 * missing, so the card is never an empty box; the sky above it carries the
 * place, the numeral, the condition and the outlook and is never a card.
 */
export function HeroDataCard({
  current,
  placeName,
  hourly,
  utcOffsetSeconds,
  now,
  hasSelection,
  activityLine,
}: Props) {
  const hasHourly = Boolean(hourly?.time?.length);
  const nowTemperature = current.temperature_2m;
  const nowKnown = Number.isFinite(nowTemperature);

  // null = the place's clock is not known yet (before mount).
  const strip = useMemo(
    () =>
      now ? heroHourStrip(hourly, now, utcOffsetSeconds, nowTemperature) : null,
    [now, hourly, utcOffsetSeconds, nowTemperature],
  );
  const curveSource = useMemo<HeroCurveSource | null>(
    () =>
      now
        ? { hourly, now, offsetSeconds: utcOffsetSeconds, nowTemperature }
        : null,
    [now, hourly, utcOffsetSeconds, nowTemperature],
  );
  const readings = heroReadings(current);

  return (
    <section
      aria-labelledby="hero-card-heading"
      data-hero-card
      className={HERO_CARD_CLASS}
    >
      <h3 id="hero-card-heading" className="sr-only">
        Next hours and readings for {placeName}
      </h3>

      {/* The next hours. Before the clock is known the first cell ("Now",
          the numeral's own temperature) is real and the rest hold their
          width, so nothing moves when the hours arrive. */}
      {strip === null
        ? hasHourly &&
          nowKnown && (
            <ol className={HERO_STRIP_CLASS}>
              {Array.from({ length: HERO_STRIP_HOURS }, (_, i) => (
                <li
                  key={i}
                  aria-hidden={i === 0 ? undefined : true}
                  className={HERO_STRIP_CELL_CLASS}
                >
                  <span className={`block text-text-secondary ${HERO_CAPTION}`}>
                    {i === 0 ? "Now" : <>&nbsp;</>}
                  </span>
                  <span className={`block ${HERO_FIGURE}`}>
                    {i === 0 ? formatDegrees(nowTemperature) : <>&nbsp;</>}
                  </span>
                </li>
              ))}
            </ol>
          )
        : strip.length > 0 && (
            <ol className={HERO_STRIP_CLASS}>
              {strip.map((hour) => (
                <li key={hour.time} className={HERO_STRIP_CELL_CLASS}>
                  <span className={`block text-text-secondary ${HERO_CAPTION}`}>
                    {hour.label}
                  </span>
                  <span className={`block ${HERO_FIGURE}`}>
                    {formatDegrees(hour.temperature)}
                  </span>
                </li>
              ))}
            </ol>
          )}

      <HeroDayCurve source={curveSource} reserve={now === null && hasHourly} />

      {readings.length > 0 && (
        <dl className={HERO_READINGS_CLASS}>
          {readings.map((reading) => (
            <div key={reading.key} className={HERO_READING_CLASS}>
              <dt className={`text-text-secondary ${HERO_CAPTION}`}>
                {reading.label}
              </dt>
              <dd
                className={`flex flex-wrap items-baseline gap-x-1 ${HERO_FIGURE}`}
              >
                <span>{reading.value}</span>
                {reading.unit && (
                  <span
                    className={`font-normal text-text-secondary ${HERO_CAPTION}`}
                  >
                    {reading.unit}
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <ActivitiesRow hasSelection={hasSelection} activityLine={activityLine} />
    </section>
  );
}

/**
 * The card's last row. Nothing picked: "Add your activities", a full-width
 * target that opens the same place the activities invitation opens (My
 * Weather, Activities tab). Activities picked: the clause for the first one
 * with a readable forecast, as the hero has always shown it, and no
 * invitation; with nothing to say there is no row.
 */
function ActivitiesRow({
  hasSelection,
  activityLine,
}: {
  hasSelection: boolean;
  activityLine: HeroActivityLine | null;
}) {
  const openMyWeather = useAppStore((s) => s.openMyWeather);
  const row = HERO_ROW_CLASS;

  if (hasSelection) {
    if (!activityLine) return null;
    return (
      <p className={row}>
        <span
          aria-hidden="true"
          className={`size-2.5 shrink-0 rounded-full ring-2 ring-current ${activityLine.dot}`}
        />
        <span className="min-w-0">
          {activityLine.label}: {activityLine.clause}
        </span>
      </p>
    );
  }
  return (
    <button
      type="button"
      onClick={() => openMyWeather("activities")}
      className={`${row} justify-between text-left hover:text-primary`}
    >
      <span>Add your activities</span>
      <span aria-hidden="true">→</span>
    </button>
  );
}
