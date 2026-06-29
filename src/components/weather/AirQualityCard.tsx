"use client";

import { useState, useEffect, useRef } from "react";
import { MetricCard, type GaugeConfig } from "./MetricCard";
import { CloudIcon } from "@/lib/weather-icons";

/**
 * Air Quality Index (AQI) gauge card.
 *
 * Fetches `/api/py/airquality` on mount, then renders an 8th MetricCard
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
 * Map AQI bucket → severity stroke class.
 *
 * Pure function so it's exercised by tests without mounting the component.
 * Tracks the EPA 6-bucket scale; the mukoko `severity-extreme` token covers
 * both "Very Unhealthy" (201-300) and "Hazardous" (301+) since we only have
 * 5 severity stops.
 */
export function aqiGauge(aqi: number): GaugeConfig {
  const percent = Math.min((aqi / 500) * 100, 100);
  if (aqi <= 50) return { percent, strokeClass: "stroke-severity-low" };
  if (aqi <= 100) return { percent, strokeClass: "stroke-severity-moderate" };
  if (aqi <= 150) return { percent, strokeClass: "stroke-severity-high" };
  if (aqi <= 200) return { percent, strokeClass: "stroke-severity-severe" };
  return { percent, strokeClass: "stroke-severity-extreme" };
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
      <MetricCard
        icon={<CloudIcon size={16} />}
        label="Air Quality"
        value="…"
        context="Loading"
        gauge={{ percent: 0, strokeClass: "stroke-severity-low" }}
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
        gauge={{ percent: 0, strokeClass: "stroke-severity-low" }}
      />
    );
  }

  const data = state.data;
  const dominantLabel = data.dominantPollutant
    ? POLLUTANT_LABELS[data.dominantPollutant]
    : null;
  const levelLabel = AQI_LEVEL_LABELS[data.level] ?? data.level;
  const context = dominantLabel ? `${levelLabel} · ${dominantLabel}` : levelLabel;

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
