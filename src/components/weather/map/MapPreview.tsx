"use client";

import Link from "next/link";
import type { WeatherLocation } from "@/lib/locations";
import { useAppStore } from "@/lib/store";
import { resolveTheme } from "@/lib/theme";
import { staticMapTiles, STATIC_TILE_SIZE } from "@/lib/static-map";

const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_API_KEY ?? "";

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
  const theme = useAppStore((s) => s.theme);
  const isDark = resolveTheme(theme) === "dark";
  const map = MAPTILER_KEY
    ? staticMapTiles({
        lat: location.lat,
        lon: location.lon,
        zoom: PREVIEW_ZOOM,
        style: isDark ? "streets-v2-dark" : "streets-v2",
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
                  width={STATIC_TILE_SIZE}
                  height={STATIC_TILE_SIZE}
                  preserveAspectRatio="none"
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
              © MapTiler © OpenStreetMap
            </span>
          )}
        </Link>
      </div>
    </section>
  );
}
