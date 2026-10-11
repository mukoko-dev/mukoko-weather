"use client";

import { useState } from "react";
import Link from "next/link";
import type { WeatherLocation } from "@/lib/locations";
import { MAPTILER_KEY, maptilerStyleId } from "@/lib/map-layers";
import { staticMapTiles, STATIC_TILE_SIZE } from "@/lib/static-map";
import { useMapIsDark } from "./use-map-style";

/** Same framing as the old interactive preview. */
const PREVIEW_ZOOM = 10;

interface MapPreviewProps {
  location: WeatherLocation;
}

/**
 * Location-page map card. A static picture built from four MapTiler raster
 * tiles in an SVG (see src/lib/static-map.ts) instead of a MapLibre map: the
 * card is not interactive, it only links to the full map, so it needs no map
 * library, worker, style, sprites or glyphs (#266).
 */
export function MapPreview({ location }: MapPreviewProps) {
  const isDark = useMapIsDark();
  // A tile that fails (bad key, quota, offline) swaps the picture for the
  // text fallback rather than leaving a bare square with a dot.
  const [failed, setFailed] = useState(false);
  const map =
    MAPTILER_KEY && !failed
      ? staticMapTiles({
          lat: location.lat,
          lon: location.lon,
          zoom: PREVIEW_ZOOM,
          style: maptilerStyleId(isDark),
          apiKey: MAPTILER_KEY,
        })
      : null;

  return (
    <section aria-labelledby="map-preview-heading">
      <div className="baobab p-0 overflow-hidden">
        <div className="flex items-center justify-between gap-2 px-[var(--space-card)] pt-[var(--space-card)] pb-2">
          <h2 id="map-preview-heading" className="giraffe">
            Weather Map
          </h2>
          <Link
            href={`/${location.slug}/map`}
            className="dikdik min-h-[var(--touch-target-min)]"
          >
            Explore map &rarr;
          </Link>
        </div>

        <Link
          href={`/${location.slug}/map`}
          className="relative z-0 block w-full aspect-square bg-surface-base focus-visible:outline-2 focus-visible:outline-primary"
          aria-label={`Open weather map for ${location.name}`}
        >
          {map ? (
            <svg
              viewBox={map.viewBox}
              preserveAspectRatio="xMidYMid slice"
              className="absolute inset-0 h-full w-full"
              aria-hidden="true"
            >
              {map.tiles.map((t) => (
                <image
                  key={t.href}
                  href={t.href}
                  x={t.x}
                  y={t.y}
                  // One extra pixel overlaps the neighbour, hiding the hairline
                  // seam that anti-aliasing leaves at fractional scales.
                  width={STATIC_TILE_SIZE + 1}
                  height={STATIC_TILE_SIZE + 1}
                  preserveAspectRatio="none"
                  onError={() => setFailed(true)}
                />
              ))}
              {/* Location marker, coloured from the primary token. */}
              <circle
                cx={map.cx}
                cy={map.cy}
                r={11}
                className="fill-primary stroke-surface-card"
                strokeWidth={4}
              />
            </svg>
          ) : (
            <span className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-text-tertiary">
              Open the weather map
            </span>
          )}
          {/* Gradient overlay — tap-to-expand affordance */}
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-surface-card/80 to-transparent"
            aria-hidden="true"
          />
          {map && (
            <span className="absolute bottom-1 right-2 text-xs text-text-secondary">
              © MapTiler © OpenStreetMap contributors
            </span>
          )}
        </Link>
      </div>
    </section>
  );
}
