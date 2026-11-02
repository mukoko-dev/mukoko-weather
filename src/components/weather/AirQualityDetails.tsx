"use client";

import { roundCoord } from "@/lib/location-privacy";
import { useState, useEffect, useRef } from "react";
import {
  formatPollutant,
  POLLUTANT_LABELS,
  AQI_LEVEL_LABELS,
  type AirQualityResponse,
  type PollutantKey,
} from "./AirQualityCard";
import { fetchWorker } from "@/lib/weather-api";
import { aqiScalePct } from "@/lib/air-quality-details";
import { trackWindow } from "@/lib/scale-blend";
import { blendGradient } from "./widgets/geometry";

/**
 * Air Quality Details — full pollutant breakdown for the atmosphere sub-route.
 *
 * Shows all 7 pollutants (PM2.5, PM10, O₃, NO₂, SO₂, CO, NH₃) in a `.baobab`
 * card grid alongside each concentration's EPA AQI sub-index, severity bar,
 * and WHO 2021 guideline reference value. Fetches the same `/v1/air-quality`
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

/**
 * Fill of a pollutant's bar (0-100%): where its EPA sub-index sits on the same
 * scale as the Air quality card's bar (each EPA band an equal sixth), so one
 * value is at one place on both bars.
 */
export function severityBarWidth(aqi: number | undefined): number {
  if (aqi === undefined) return 0;
  return aqiScalePct(aqi);
}

/**
 * A pollutant's severity bar. The fill is a window onto the one blended AQI
 * gradient (official EPA colours, green to maroon), so it shows every colour
 * up to the sub-index and a reading in the middle of a band shows that band's
 * colour; it is not a single solid band colour any more. Decorative: the
 * sub-index is printed above it. The fill's width is not animated: the
 * gradient inside is sized from it, so a width transition would slide the
 * colours instead of revealing them.
 */
export function PollutantBar({ subIndex }: { subIndex: number | undefined }) {
  const pct = severityBarWidth(subIndex);
  const win = trackWindow(0, pct);
  return (
    <div
      className="mt-3 h-1.5 w-full rounded-full bg-text-tertiary/15 ring-1 ring-wx-outline"
      role="presentation"
      aria-hidden="true"
    >
      {pct > 0 && (
        <div
          className="relative h-full overflow-hidden rounded-full"
          style={{ width: `${win.width}%` }}
        >
          <div
            className="absolute inset-y-0"
            style={{
              left: `${win.innerLeft}%`,
              width: `${win.innerWidth}%`,
              backgroundImage: blendGradient("aqi"),
            }}
          />
        </div>
      )}
    </div>
  );
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

    fetchWorker(
      "air-quality",
      `lat=${roundCoord(lat)}&lon=${roundCoord(lon)}`,
      {
        signal: controller.signal,
      },
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<AirQualityResponse>;
      })
      .then((json) => {
        if (cancelled) return;
        setState({ status: "ready", data: json });
      })
      .catch((err: unknown) => {
        if (
          cancelled ||
          (err as { name?: string } | null)?.name === "AbortError"
        )
          return;
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
  const subIndexes: Partial<Record<PollutantKey, number>> =
    data.subIndexes ?? {};
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

      <div className="herd-grid">
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
                {sub !== undefined && <span className="dove">AQI {sub}</span>}
              </div>

              <p className="mt-2 text-2xl font-bold text-text-primary font-heading">
                {formatPollutant(value)}
              </p>

              <PollutantBar subIndex={sub} />

              {whoNote && <p className="dove mt-2">{whoNote}</p>}
            </article>
          );
        })}
      </div>
    </section>
  );
}
