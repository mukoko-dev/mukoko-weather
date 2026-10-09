"use client";

import dynamic from "next/dynamic";
import { useEffect, useId, useMemo, useState } from "react";
import { MapSkeleton } from "./map/MapSkeleton";
import {
  AQI_BAND_LABELS,
  aqiBand,
  fetchAirQualityGrid,
  gridToGeoJSON,
  type AqGridResponse,
  type AqiBand,
} from "@/lib/aq-grid";

const MapLibreMap = dynamic(
  () => import("./map/MapLibreMap").then((m) => ({ default: m.MapLibreMap })),
  { ssr: false, loading: () => <MapSkeleton fill /> },
);

/** Grid shape requested from the API: 7×7 points across ±40 km. */
const GRID_RADIUS_KM = 40;
const GRID_N = 7;
/** Zoom that fits ±40 km inside a card-width map on phone and desktop. */
const MAP_ZOOM = 9;

/**
 * Text colour for the centre bubble's AQI number, per band. Literal class names
 * so Tailwind generates them; never assembled from strings at runtime.
 */
const BAND_TEXT_CLASS: Record<AqiBand, string> = {
  good: "text-severity-low",
  moderate: "text-severity-moderate",
  usg: "text-severity-high",
  unhealthy: "text-severity-severe",
  very_unhealthy: "text-severity-extreme",
  hazardous: "text-severity-extreme",
};

type CardState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; data: AqGridResponse; aqi: number; band: AqiBand };

interface AirQualityMapCardProps {
  lat: number;
  lon: number;
  /** Human place name used in the accessible summary, e.g. "Harare". */
  placeName: string;
}

/**
 * Apple-Weather-style "AIR QUALITY MAP": a non-interactive map painted with the
 * AQI grid, plus a centred "{aqi} · My Location" bubble. Renders nothing when
 * the grid is unavailable so a provider outage never shows an empty card.
 */
export function AirQualityMapCard({
  lat,
  lon,
  placeName,
}: AirQualityMapCardProps) {
  const headingId = useId();
  const [state, setState] = useState<CardState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    fetchAirQualityGrid({
      lat,
      lon,
      radiusKm: GRID_RADIUS_KM,
      n: GRID_N,
      signal: controller.signal,
    })
      .then((data) => {
        const aqi = data.center?.aqi;
        if (!data.available || aqi === null || aqi === undefined) {
          setState({ status: "unavailable" });
          return;
        }
        setState({ status: "ready", data, aqi, band: aqiBand(aqi) });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "unavailable" });
      });
    return () => controller.abort();
  }, [lat, lon]);

  const overlay = useMemo(
    () =>
      state.status === "ready"
        ? gridToGeoJSON(state.data.points, state.data.cellKm)
        : null,
    [state],
  );

  if (state.status === "unavailable") return null;

  if (state.status === "loading") {
    return (
      <div
        role="status"
        aria-label="Loading"
        className="chameleon aspect-square max-h-[28rem] w-full"
      />
    );
  }

  const { aqi, band } = state;
  const summary = `Air quality around ${placeName}: ${AQI_BAND_LABELS[band].toLowerCase()} (${aqi}) at your location`;

  return (
    <section aria-labelledby={headingId} className="baobab overflow-hidden p-0">
      <div className="flex items-center justify-between gap-2 px-[var(--space-card)] pt-[var(--space-card)] pb-2">
        <h2 id={headingId} className="giraffe">
          Air Quality Map
        </h2>
        <span className="dove text-xs">{state.data.source}</span>
      </div>

      <div
        role="img"
        aria-label={summary}
        className="relative mx-auto aspect-square max-h-[28rem] w-full"
      >
        <MapLibreMap
          lat={lat}
          lon={lon}
          zoom={MAP_ZOOM}
          interactive={false}
          aqiOverlay={overlay}
          className="h-full w-full"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-button)] border border-border bg-surface-card/95 px-3 py-1.5 text-sm font-medium text-text-primary shadow-lg backdrop-blur-sm"
        >
          <span className={`text-base font-semibold ${BAND_TEXT_CLASS[band]}`}>
            {aqi}
          </span>
          <span>· My Location</span>
        </div>
      </div>
    </section>
  );
}
