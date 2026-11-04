"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { MapCredits } from "./map/MapCredits";
import { StaticMapTiles, useStaticTileMap } from "./map/StaticTileMap";
import {
  AQI_BAND_BG_CLASS,
  AQI_BAND_FILL_CLASS,
  AQI_BAND_LABELS,
  aqiBand,
  fetchAirQualityGrid,
  gridToGeoJSON,
  type AqGridResponse,
  type AqiBand,
} from "@/lib/aq-grid";
import { aqStaticCells } from "@/lib/aq-static-cells";
import { attributionForLayer } from "@/lib/map-sources";

/** Grid shape requested from the API: 7×7 points across ±40 km. */
const GRID_RADIUS_KM = 40;
const GRID_N = 7;
/** Zoom that fits ±40 km inside a card-width map on phone and desktop. */
const MAP_ZOOM = 9;

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
 * Apple-Weather-style "AIR QUALITY MAP": a picture of the AQI grid around the
 * place, plus a centred "{aqi} · My Location" bubble. Renders nothing when the
 * grid is unavailable so a provider outage never shows an empty card.
 *
 * The picture is four MapTiler raster tiles with the grid's cells drawn over
 * them as SVG polygons (src/lib/static-map.ts, src/lib/aq-static-cells.ts), not
 * a MapLibre map (#476). The card cannot be panned or zoomed, and as a map it
 * cost a WebGL context, web workers, about 1.2 MB of script and 40 to 50 MB
 * of the tab's memory (measured: scripts/browser-check/memory-budget.mjs), the
 * single largest thing on the place page. The full, interactive map is
 * `/[location]/map`.
 */
export function AirQualityMapCard({
  lat,
  lon,
  placeName,
}: AirQualityMapCardProps) {
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

  return (
    <AirQualityMapView
      lat={lat}
      lon={lon}
      placeName={placeName}
      data={state.data}
      aqi={state.aqi}
      band={state.band}
    />
  );
}

/** The card once the grid has arrived (exported for the rendered tests). */
export function AirQualityMapView({
  lat,
  lon,
  placeName,
  data,
  aqi,
  band,
}: AirQualityMapCardProps & {
  data: AqGridResponse;
  aqi: number;
  band: AqiBand;
}) {
  const headingId = useId();
  const { picture, tilesShown, onTileError } = useStaticTileMap({
    lat,
    lon,
    zoom: MAP_ZOOM,
  });
  const cells = useMemo(
    () => aqStaticCells(gridToGeoJSON(data.points, data.cellKm), MAP_ZOOM),
    [data],
  );
  const summary = `Air quality around ${placeName}: ${AQI_BAND_LABELS[band].toLowerCase()} (${aqi}) at your location`;

  return (
    <section aria-labelledby={headingId} className="baobab overflow-hidden p-0">
      <div className="flex items-center justify-between gap-2 px-[var(--space-card)] pt-[var(--space-card)] pb-2">
        <h2 id={headingId} className="giraffe">
          Air Quality Map
        </h2>
        <span className="dove text-xs">{data.source}</span>
      </div>

      <div
        role="img"
        aria-label={summary}
        className="relative mx-auto aspect-square max-h-[28rem] w-full bg-surface-base"
      >
        <svg
          viewBox={picture.viewBox}
          preserveAspectRatio="xMidYMid slice"
          className="absolute inset-0 h-full w-full"
          aria-hidden="true"
        >
          {tilesShown && (
            <StaticMapTiles picture={picture} onTileError={onTileError} />
          )}
          {/* One square per grid point, in its EPA band's colour; the outline
              carries the contrast the official fills cannot (see the full map). */}
          {cells.map((cell) => (
            <polygon
              key={cell.id}
              points={cell.points}
              className={`${AQI_BAND_FILL_CLASS[cell.band]} stroke-wx-outline`}
              fillOpacity={0.55}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-button)] border border-border bg-surface-card/95 px-3 py-1.5 text-sm font-medium text-text-primary shadow-lg backdrop-blur-sm"
        >
          <span
            aria-hidden="true"
            className={`size-3 shrink-0 rounded-full ring-1 ring-wx-outline ${AQI_BAND_BG_CLASS[band]}`}
          />
          <span className="text-base font-semibold text-text-primary">
            {aqi}
          </span>
          <span>· My Location</span>
        </div>
      </div>
      {/* Credits outside the picture (they are links), generated from
          map-sources.ts like the full map's: the base map and the air quality
          data. */}
      <MapCredits
        credits={attributionForLayer("airQuality")}
        className="mt-0 px-[var(--space-card)] py-2 text-xs"
      />
    </section>
  );
}
