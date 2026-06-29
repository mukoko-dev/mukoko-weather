"use client";

import { useState, useEffect, useRef } from "react";
import {
  formatPollutant,
  POLLUTANT_LABELS,
  AQI_LEVEL_LABELS,
  type AirQualityResponse,
  type PollutantKey,
} from "./AirQualityCard";

/**
 * Air Quality Details — full pollutant breakdown for the atmosphere sub-route.
 *
 * Shows all 7 pollutants (PM2.5, PM10, O₃, NO₂, SO₂, CO, NH₃) in a `.baobab`
 * card grid alongside each concentration's EPA AQI sub-index, severity bar,
 * and WHO 2021 guideline reference value. Fetches the same `/api/py/airquality`
 * endpoint as the compact `AirQualityCard` — caching means the second hit is
 * served from cache.
 */

interface Props {
  lat: number;
  lon: number;
}

/** Pollutant display order — PM particles first (highest health impact). */
const POLLUTANT_ORDER: PollutantKey[] = [
  "pm2_5",
  "pm10",
  "o3",
  "no2",
  "so2",
  "co",
  "nh3",
];

/** Map an EPA AQI bucket to the matching severity bar token. */
export function severityBarClass(aqi: number | undefined): string {
  if (aqi === undefined) return "bg-text-tertiary/20";
  if (aqi <= 50) return "bg-severity-low";
  if (aqi <= 100) return "bg-severity-moderate";
  if (aqi <= 150) return "bg-severity-high";
  if (aqi <= 200) return "bg-severity-severe";
  return "bg-severity-extreme";
}

/** Bar width (0-100%) based on EPA sub-index relative to a 500 max. */
export function severityBarWidth(aqi: number | undefined): number {
  if (aqi === undefined) return 0;
  return Math.min((aqi / 500) * 100, 100);
}

type AQDetailsState =
  | { status: "loading" }
  | { status: "ready"; data: AirQualityResponse }
  | { status: "error" };

export function AirQualityDetails({ lat, lon }: Props) {
  // Single state object — same React-compiler pattern as AirQualityCard.
  const [state, setState] = useState<AQDetailsState>({ status: "loading" });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    let cancelled = false;

    fetch(`/api/py/airquality?lat=${lat}&lon=${lon}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<AirQualityResponse>;
      })
      .then((json) => {
        if (cancelled) return;
        setState({ status: "ready", data: json });
      })
      .catch((err: unknown) => {
        if (cancelled || (err as { name?: string } | null)?.name === "AbortError") return;
        setState({ status: "error" });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [lat, lon]);

  if (state.status === "loading") {
    return (
      <section aria-labelledby="air-quality-heading">
        <h2 id="air-quality-heading" className="giraffe mb-3">
          Air Quality
        </h2>
        <p className="dove">Loading pollutant data…</p>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section aria-labelledby="air-quality-heading">
        <h2 id="air-quality-heading" className="giraffe mb-3">
          Air Quality
        </h2>
        <p className="dove">Air quality data is temporarily unavailable.</p>
      </section>
    );
  }

  const data = state.data;
  const subIndexes: Partial<Record<PollutantKey, number>> = data.subIndexes ?? {};
  const who: Partial<Record<PollutantKey, number>> = data.whoGuidelines ?? {};

  return (
    <section aria-labelledby="air-quality-heading">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 id="air-quality-heading" className="giraffe">
          Air Quality
        </h2>
        <span className="dove">
          EPA AQI {data.aqi} · {AQI_LEVEL_LABELS[data.level] ?? data.level}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {POLLUTANT_ORDER.map((key) => {
          const value = data.pollutants?.[key] ?? null;
          const sub = subIndexes[key];
          const whoTarget = who[key];
          const whoNote =
            whoTarget && whoTarget > 0 && value !== null
              ? value <= whoTarget
                ? `At or below WHO target (${formatPollutant(whoTarget)})`
                : `Above WHO target (${formatPollutant(whoTarget)})`
              : whoTarget === 0
              ? "No WHO guideline"
              : "";

          return (
            <article
              key={key}
              className="baobab"
              aria-label={`${POLLUTANT_LABELS[key]} pollutant data`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="hornbill">{POLLUTANT_LABELS[key]}</span>
                {sub !== undefined && (
                  <span className="dove">AQI {sub}</span>
                )}
              </div>

              <p className="mt-2 text-2xl font-bold text-text-primary font-heading">
                {formatPollutant(value)}
              </p>

              <div
                className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-text-tertiary/15"
                role="presentation"
                aria-hidden="true"
              >
                <div
                  className={`h-full ${severityBarClass(sub)} transition-all duration-500`}
                  style={{ width: `${severityBarWidth(sub)}%` }}
                />
              </div>

              {whoNote && <p className="dove mt-2">{whoNote}</p>}
            </article>
          );
        })}
      </div>
    </section>
  );
}
