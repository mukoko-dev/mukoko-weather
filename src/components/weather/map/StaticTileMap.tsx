"use client";

import { useState } from "react";
import { MAPTILER_KEY, maptilerStyleId } from "@/lib/map-layers";
import {
  allTilesFailed,
  staticMapTiles,
  STATIC_TILE_SIZE,
  wantsRetinaTiles,
  withFailedTile,
  type StaticMap,
  type TileFailures,
} from "@/lib/static-map";
import { useMapIsDark } from "./use-map-style";

const EMPTY: ReadonlySet<string> = new Set();

export interface StaticTileMapState {
  /** The picture's geometry (viewBox, the place in world pixels, the tiles). */
  picture: StaticMap;
  /**
   * Whether the tiles should be drawn: a MapTiler key is set and at least one
   * tile has not failed. When false the caller shows its own fallback.
   */
  tilesShown: boolean;
  /** Call from each tile's `onError`. */
  onTileError(href: string): void;
}

/**
 * The state behind a static, non-interactive map card (MapPreview, the air
 * quality card): the theme's raster style, `@2x` tiles on dense screens and
 * per-tile failure tracking, so one bad tile leaves the rest drawn. These
 * cards are four raster tiles in an SVG instead of a MapLibre map (#266,
 * #476): no WebGL context, no worker, no map library.
 */
export function useStaticTileMap(opts: {
  lat: number;
  lon: number;
  zoom: number;
}): StaticTileMapState {
  const isDark = useMapIsDark();
  // High-DPI screens get the documented @2x tiles (same area, twice the
  // pixels); read once, on the client (these cards only mount there).
  const [retina, setRetina] = useState(
    () =>
      typeof window !== "undefined" &&
      wantsRetinaTiles(window.devicePixelRatio),
  );
  // Failed tiles are tracked per tile, and only for the theme + density they
  // failed under, so a theme change starts afresh. One bad tile leaves the
  // others drawn; the fallback shows only when none loaded.
  const variant = `${isDark ? "dark" : "light"}:${retina ? "2x" : "1x"}`;
  const [failures, setFailures] = useState<TileFailures>({
    variant,
    hrefs: new Set(),
  });
  const failed = failures.variant === variant ? failures.hrefs : EMPTY;

  const picture = staticMapTiles({
    lat: opts.lat,
    lon: opts.lon,
    zoom: opts.zoom,
    style: maptilerStyleId(isDark),
    apiKey: MAPTILER_KEY,
    retina,
  });
  const tilesShown = !!MAPTILER_KEY && !allTilesFailed(picture, failed);

  const onTileError = (href: string) => {
    if (retina && failed.size === 0) {
      // The @2x variant is the one thing here we cannot rely on being served
      // for every key/style: retry once with the plain tiles before giving up.
      setRetina(false);
      return;
    }
    // From the latest state, not this render's snapshot: tiles that fail in
    // the same tick must all be recorded (withFailedTile).
    setFailures((prev) => withFailedTile(prev, variant, href));
  };

  return { picture, tilesShown, onTileError };
}

/** The tiles, as SVG `<image>`s in world pixels; render inside the picture's `<svg>`. */
export function StaticMapTiles({
  picture,
  onTileError,
}: {
  picture: StaticMap;
  onTileError(href: string): void;
}) {
  return (
    <>
      {picture.tiles.map((t) => (
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
          onError={() => onTileError(t.href)}
        />
      ))}
    </>
  );
}
