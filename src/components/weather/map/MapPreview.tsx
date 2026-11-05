"use client";

import Link from "next/link";
import type { WeatherLocation } from "@/lib/locations";
import { attributionForLayer } from "@/lib/map-sources";
import { MapCredits } from "./MapCredits";
import { StaticMapTiles, useStaticTileMap } from "./StaticTileMap";

/** Same framing as the old interactive preview. */
const PREVIEW_ZOOM = 10;

interface MapPreviewProps {
  location: WeatherLocation;
}

/**
 * Location-page map card. A static picture built from four MapTiler raster
 * tiles in an SVG (see src/lib/static-map.ts) instead of a MapLibre map: the
 * card is not interactive, it only links to the full map, so it needs no map
 * library, worker, style, sprites or glyphs (#266). Credits come from
 * map-sources.ts (`attributionForLayer(null)`: the base map's providers).
 */
export function MapPreview({ location }: MapPreviewProps) {
  const { picture, tilesShown, onTileError } = useStaticTileMap({
    lat: location.lat,
    lon: location.lon,
    zoom: PREVIEW_ZOOM,
  });
  const map = tilesShown ? picture : null;

  return (
    <section aria-labelledby="map-preview-heading">
      {/* mzizi-spacing-exempt: the card is edge to edge for the map picture; its header row carries the card inset (--space-card, 16 to 20px) itself */}
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
              <StaticMapTiles picture={map} onTileError={onTileError} />
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
        </Link>
        {/* Credits outside the link (they are links themselves), generated from
            map-sources.ts like the full map's. */}
        {map && (
          <MapCredits
            credits={attributionForLayer(null)}
            className="mt-0 px-[var(--space-card)] py-2 text-sm"
          />
        )}
      </div>
    </section>
  );
}
