/**
 * Map layer configuration for Tomorrow.io weather tile overlays.
 * Each layer maps to a Tomorrow.io tile API layer name and has
 * mineral-color styles following the CATEGORY_STYLES pattern.
 *
 * Base map tiles are served directly from MapTiler CDN (no proxy):
 * MAPTILER_STYLE_LIGHT / MAPTILER_STYLE_DARK
 */

const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_API_KEY ?? "";

export const MAPTILER_STYLE_LIGHT = `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`;
export const MAPTILER_STYLE_DARK = `https://api.maptiler.com/maps/streets-v2-dark/style.json?key=${MAPTILER_KEY}`;

export interface MapLayer {
  id: string;
  label: string;
  description: string;
  /**
   * Lucide icon name for the compact overlay icon group. Resolved to a
   * `lucide-react` component in `WeatherLayerPanel` (kept out of this data
   * module so it stays a plain, testable config with no React imports).
   */
  icon: string;
  /** Mineral color CSS classes for the layer toggle button */
  style: {
    bg: string;
    border: string;
    text: string;
    badge: string;
  };
}

export const MAP_LAYERS: MapLayer[] = [
  {
    id: "precipitationIntensity",
    label: "Rain",
    description: "Precipitation intensity radar",
    icon: "CloudRain",
    style: {
      bg: "bg-mineral-cobalt/10",
      border: "border-mineral-cobalt/30",
      text: "text-mineral-cobalt",
      badge: "bg-mineral-cobalt text-mineral-cobalt-fg",
    },
  },
  {
    id: "cloudCover",
    label: "Cloud",
    description: "Cloud cover satellite",
    icon: "Cloud",
    style: {
      bg: "bg-text-tertiary/10",
      border: "border-text-tertiary/30",
      text: "text-text-secondary",
      badge: "bg-text-tertiary text-surface-card",
    },
  },
  {
    id: "temperature",
    label: "Temp",
    description: "Temperature map",
    icon: "Thermometer",
    style: {
      bg: "bg-mineral-terracotta/10",
      border: "border-mineral-terracotta/30",
      text: "text-mineral-terracotta",
      badge: "bg-mineral-terracotta text-mineral-terracotta-fg",
    },
  },
  {
    id: "windSpeed",
    label: "Wind",
    description: "Wind speed and direction",
    icon: "Wind",
    style: {
      bg: "bg-mineral-malachite/10",
      border: "border-mineral-malachite/30",
      text: "text-mineral-malachite",
      badge: "bg-mineral-malachite text-mineral-malachite-fg",
    },
  },
  {
    id: "humidity",
    label: "Humidity",
    description: "Relative humidity",
    icon: "Droplets",
    style: {
      bg: "bg-mineral-tanzanite/10",
      border: "border-mineral-tanzanite/30",
      text: "text-mineral-tanzanite",
      badge: "bg-mineral-tanzanite text-mineral-tanzanite-fg",
    },
  },
];

/**
 * Cloud cover is the default overlay — it renders reliably (a non-time-indexed
 * Tomorrow.io field, like temperature) whereas the precipitation radar tile can
 * 400 without a valid recent timestamp. Defaulting to a known-good layer means
 * the map opens with a working overlay instead of an error banner. Cloud is also
 * the most flight-relevant layer (see aviation ceilings work).
 */
export const DEFAULT_LAYER = "cloudCover";

export function getMapLayerById(id: string): MapLayer | undefined {
  return MAP_LAYERS.find((l) => l.id === id);
}

/**
 * Tomorrow.io weather overlay tiles are only served for zoom levels 1–12
 * (see the `/api/py/map-tiles` proxy, which rejects z<1 or z>12 with HTTP 400).
 * Pinning the raster source to this range makes MapLibre overzoom the z12 tile
 * when the user zooms in past 12 instead of requesting z13+ tiles the proxy
 * rejects — which would otherwise make the overlay vanish when zoomed in.
 */
export const WEATHER_OVERLAY_MIN_ZOOM = 1;
export const WEATHER_OVERLAY_MAX_ZOOM = 12;

/** Shared MapLibre source/layer id for the weather overlay. */
export const WEATHER_OVERLAY_ID = "weather-overlay";

/**
 * Builds the proxied tile URL template for a Tomorrow.io weather overlay layer.
 * MapLibre substitutes {z}/{x}/{y} at request time. Tiles are proxied through
 * the Python backend (`/api/py/map-tiles`) so the Tomorrow.io key stays server-side.
 */
export function weatherOverlayTileUrl(layerId: string): string {
  return `/api/py/map-tiles?z={z}&x={x}&y={y}&layer=${encodeURIComponent(layerId)}`;
}

/**
 * Raster source spec for a weather overlay layer, with minzoom/maxzoom pinned
 * to the Tomorrow.io tile availability range so the overlay keeps rendering
 * (via overzoom) at high map zooms instead of silently disappearing.
 */
export function buildWeatherOverlaySource(layerId: string) {
  return {
    type: "raster" as const,
    tiles: [weatherOverlayTileUrl(layerId)],
    tileSize: 256,
    minzoom: WEATHER_OVERLAY_MIN_ZOOM,
    maxzoom: WEATHER_OVERLAY_MAX_ZOOM,
  };
}
