"use client";

import { roundCoord } from "@/lib/location-privacy";
import { useState, useEffect, useRef } from "react";
import { MetricCard, type GaugeConfig } from "./MetricCard";
import { AQI_SCALE, aqiScaleBand } from "@/lib/weather-scales";
import { CloudIcon } from "@/lib/weather-icons";
import { fetchWorker } from "@/lib/weather-api";

/**
 * Air Quality Index (AQI) gauge card.
 *
 * Fetches the Worker's `/v1/air-quality` on mount, then renders an 8th MetricCard
 * alongside humidity/wind/pressure/etc. Uses the EPA 0-500 AQI scale —
 * sub-150 is generally safe, 150+ is "Unhealthy for Sensitive Groups",
 * 200+ is "Unhealthy", 300+ is "Very Unhealthy / Hazardous".
 *
 * Severity tokens map directly to the AQI bucket so a green gauge means
 * "Good" everywhere in the app. Loading/error states still render a card
 * (with a neutral gauge) so the grid doesn't collapse mid-fetch.
 */

interface Props {
  lat: number;
  lon: number;
}

export interface AirQualityResponse {
  aqi: number;
  level: AqiLevel;
  dominantPollutant: PollutantKey | null;
  pollutants: Record<PollutantKey, number | null>;
  subIndexes?: Record<PollutantKey, number>;
  whoGuidelines?: Record<PollutantKey, number>;
  source: string;
  fetchedAt?: string;
}

export type AqiLevel =
  | "good"
  | "moderate"
  | "unhealthy_sensitive"
  | "unhealthy"
  | "very_unhealthy"
  | "hazardous";

export type PollutantKey =
  | "pm2_5"
  | "pm10"
  | "o3"
  | "no2"
  | "so2"
  | "co"
  | "nh3";

/** Short labels for pollutants — used in sub-text and detail grid. */
export const POLLUTANT_LABELS: Record<PollutantKey, string> = {
  pm2_5: "PM2.5",
  pm10: "PM10",
  o3: "O₃",
  no2: "NO₂",
  so2: "SO₂",
  co: "CO",
  nh3: "NH₃",
};

/** Human-readable EPA level labels for the UI. */
export const AQI_LEVEL_LABELS: Record<AqiLevel, string> = {
  good: "Good",
  moderate: "Moderate",
  unhealthy_sensitive: "Unhealthy for Sensitive",
  unhealthy: "Unhealthy",
  very_unhealthy: "Very Unhealthy",
  hazardous: "Hazardous",
};

/**
 * Map AQI to the gauge: a SOLID arc in the current band's official EPA colour
 * (weather-scales.ts), position as a share of 0-500. A gradient would be
 * horizontal across the dial, so an AQI of 250 would draw green on its left
 * half; one band colour never misreports the reading.
 */
export function aqiGauge(aqi: number): GaugeConfig {
  const percent = Math.min((aqi / 500) * 100, 100);
  const index = Math.max(
    0,
    AQI_SCALE.bands.indexOf(aqiScaleBand(aqi) ?? AQI_SCALE.bands[0]),
  );
  return {
    percent,
    strokeClass: AQI_SCALE.bands[index].stroke,
    gradient: [`var(${AQI_SCALE.bands[index].token})`],
  };
}

/** Format a pollutant concentration with µg/m³ unit. */
export function formatPollutant(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value >= 100) return `${Math.round(value)} µg/m³`;
  return `${value.toFixed(1)} µg/m³`;
}

type AQState =
  | { status: "loading" }
  | { status: "ready"; data: AirQualityResponse }
  | { status: "error" };

export function AirQualityCard({ lat, lon }: Props) {
  // Single state object — avoids the React-compiler "cascading renders"
  // warning that fires when setLoading + setError are called back-to-back
  // at the top of an effect.
  const [state, setState] = useState<AQState>({ status: "loading" });
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
      <MetricCard
        icon={<CloudIcon size={16} />}
        label="Air Quality"
        value="…"
        context="Loading"
        gauge={{ percent: 0, strokeClass: AQI_SCALE.bands[0].stroke }}
      />
    );
  }

  if (state.status === "error") {
    return (
      <MetricCard
        icon={<CloudIcon size={16} />}
        label="Air Quality"
        value="—"
        context="Unavailable"
        gauge={{ percent: 0, strokeClass: AQI_SCALE.bands[0].stroke }}
      />
    );
  }

  const data = state.data;
  const dominantLabel = data.dominantPollutant
    ? POLLUTANT_LABELS[data.dominantPollutant]
    : null;
  const levelLabel = AQI_LEVEL_LABELS[data.level] ?? data.level;
  const context = dominantLabel
    ? `${levelLabel} · ${dominantLabel}`
    : levelLabel;

  return (
    <MetricCard
      icon={<CloudIcon size={16} />}
      label="Air Quality"
      value={`${data.aqi}`}
      context={context}
      gauge={aqiGauge(data.aqi)}
    />
  );
}
