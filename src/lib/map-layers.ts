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
 * Rain is the default map layer (design brief: the map opens on precipitation).
 * The proxy accepts the `now` timestamp for every tile layer, so the default
 * opens without a timestamp error. Matches DISPLAY_DEFAULT_LAYER.
 */
export const DEFAULT_LAYER = "precipitationIntensity";

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

/**
 * Where the browser loads MapLibre's web worker from. maplibre-gl v6 ships
 * its worker as a separate ES module and, by default, looks for it next to
 * the bundled chunk, where webpack never puts it, so the worker fails to load
 * and every map renders blank. scripts/copy-maplibre-worker.mjs copies the
 * worker (and the shared module it imports) into a per-version folder before
 * every build/dev run; MapLibreMap passes `maplibreWorkerUrl(getVersion())` to
 * setWorkerUrl() before creating a map. Keying the path by version keeps an
 * old tab's bundle paired with its own worker across deploys.
 */
export function maplibreWorkerUrl(version: string): string {
  return `/vendor/maplibre-gl/${version}/maplibre-gl-worker.mjs`;
}

/** Shared MapLibre source/layer id for the weather overlay. */
export const WEATHER_OVERLAY_ID = "weather-overlay";

/**
 * Builds the proxied tile URL template for a Tomorrow.io weather overlay layer.
 * MapLibre substitutes {z}/{x}/{y} at request time. Tiles are proxied through
 * the Python backend (`/api/py/map-tiles`) so the Tomorrow.io key stays server-side.
 */
export function weatherOverlayTileUrl(
  layerId: string,
  timestamp?: string,
): string {
  const base = `/api/py/map-tiles?z={z}&x={x}&y={y}&layer=${encodeURIComponent(layerId)}`;
  if (!timestamp || timestamp === "now") return base;
  return `${base}&timestamp=${encodeURIComponent(timestamp)}`;
}

/**
 * Raster source spec for a weather overlay layer, with minzoom/maxzoom pinned
 * to the Tomorrow.io tile availability range so the overlay keeps rendering
 * (via overzoom) at high map zooms instead of silently disappearing.
 */
export function buildWeatherOverlaySource(layerId: string, timestamp?: string) {
  return {
    type: "raster" as const,
    tiles: [weatherOverlayTileUrl(layerId, timestamp)],
    tileSize: 256,
    minzoom: WEATHER_OVERLAY_MIN_ZOOM,
    maxzoom: WEATHER_OVERLAY_MAX_ZOOM,
  };
}

/**
 * Source/layer id for the AQI grid overlay (Air Quality Map card). Kept
 * separate from WEATHER_OVERLAY_ID so the two can be shown together without
 * one clearing the other.
 */
export const AQI_OVERLAY_ID = "aqi-overlay";

/* ------------------------------------------------------------------------ *
 * Full-screen map: chips, legends, timeline
 * ------------------------------------------------------------------------ */

/** Chip id for the air-quality view. It is NOT a Tomorrow.io tile layer. */
export const AIR_QUALITY_LAYER_ID = "airQuality";

/** One colour step on a legend scale. `className` is a static Tailwind class. */
export interface LegendSegment {
  className: string;
  /** Value where this segment starts (the first label reads "0" or "Now"-style text). */
  label: string;
}

export interface LayerLegend {
  /** Unit shown next to the scale title, e.g. "mm/h". */
  unit: string;
  segments: LegendSegment[];
}

/** A labelled chip in the bottom sheet. */
export interface MapChip {
  id: string;
  label: string;
  legend: LayerLegend;
}

/**
 * Tile layers whose Tomorrow.io tiles accept forecast timestamps, so the
 * timeline scrubber is offered for them. Other layers hide the scrubber and
 * always show the current ("now") tile. Only rain is listed: the other layers
 * are not verified against forecast timestamps. Verify against the live tile
 * API before widening this set.
 */
export const TIMELINE_LAYER_IDS: readonly string[] = ["precipitationIntensity"];

/** Hours between timeline stops. */
export const TIMELINE_STEP_HOURS = 3;
/** Stops from Now (0) through +72h inclusive: 0, 3, …, 72. */
export const TIMELINE_STEPS = 25;

export function layerSupportsTimeline(layerId: string): boolean {
  return TIMELINE_LAYER_IDS.includes(layerId);
}

/**
 * Tomorrow.io tile timestamp for a timeline stop. Step 0 is `now`. Later steps
 * are whole UTC hours in the form the proxy validates
 * (`YYYY-MM-DDTHH:00:00Z`).
 */
export function timelineTimestamp(step: number, now: Date): string {
  if (step <= 0) return "now";
  const base = new Date(now.getTime());
  base.setUTCMinutes(0, 0, 0);
  base.setTime(base.getTime() + step * TIMELINE_STEP_HOURS * 3_600_000);
  return `${base.toISOString().slice(0, 19)}Z`;
}

/** Short label for a timeline stop: "Now", "+3h", "+1d". */
export function timelineLabel(step: number): string {
  if (step <= 0) return "Now";
  const hours = step * TIMELINE_STEP_HOURS;
  if (hours % 24 === 0) return `+${hours / 24}d`;
  return `+${hours}h`;
}

/** Legend for US AQI, using the severity tokens shared with the grid fill. */
export const AQI_LEGEND: LayerLegend = {
  unit: "US AQI",
  segments: [
    { className: "bg-severity-low", label: "0" },
    { className: "bg-severity-moderate", label: "51" },
    { className: "bg-severity-high", label: "101" },
    { className: "bg-severity-severe", label: "151" },
    { className: "bg-severity-extreme", label: "201+" },
  ],
};

/** Chips in display order. Air quality first, then the four tile layers. */
export const MAP_CHIPS: readonly MapChip[] = [
  {
    id: AIR_QUALITY_LAYER_ID,
    label: "Air quality",
    legend: AQI_LEGEND,
  },
  {
    id: "precipitationIntensity",
    label: "Rain",
    legend: {
      unit: "mm/h",
      segments: [
        { className: "bg-severity-low", label: "0" },
        { className: "bg-severity-moderate", label: "0.5" },
        { className: "bg-severity-high", label: "2.5" },
        { className: "bg-severity-severe", label: "10" },
        { className: "bg-severity-extreme", label: "50+" },
      ],
    },
  },
  {
    id: "temperature",
    label: "Temperature",
    legend: {
      unit: "°C",
      segments: [
        { className: "bg-mineral-cobalt", label: "<10" },
        { className: "bg-mineral-malachite", label: "15" },
        { className: "bg-mineral-gold", label: "22" },
        { className: "bg-mineral-terracotta/70", label: "30" },
        { className: "bg-mineral-terracotta", label: "38+" },
      ],
    },
  },
  {
    id: "windSpeed",
    label: "Wind",
    legend: {
      unit: "km/h",
      segments: [
        { className: "bg-mineral-malachite/25", label: "0" },
        { className: "bg-mineral-malachite/50", label: "10" },
        { className: "bg-mineral-malachite/75", label: "25" },
        { className: "bg-mineral-malachite", label: "40" },
        { className: "bg-mineral-gold", label: "60+" },
      ],
    },
  },
  {
    id: "cloudCover",
    label: "Cloud",
    legend: {
      unit: "%",
      segments: [
        { className: "bg-text-tertiary/15", label: "0" },
        { className: "bg-text-tertiary/35", label: "25" },
        { className: "bg-text-tertiary/60", label: "50" },
        { className: "bg-text-tertiary/85", label: "75" },
        { className: "bg-text-tertiary", label: "100" },
      ],
    },
  },
];

export function getMapChip(id: string): MapChip | undefined {
  return MAP_CHIPS.find((c) => c.id === id);
}

/** localStorage key for the last chosen layer. */
export const MAP_LAYER_STORAGE_KEY = "mukoko-map-layer";

/**
 * Reads the remembered layer. Returns null for a missing, unknown or
 * unreadable value (private windows and blocked storage throw). Callers fall
 * back to DEFAULT_LAYER.
 */
export function readStoredMapLayer(
  storage: Pick<Storage, "getItem"> | null | undefined,
): string | null {
  try {
    const value = storage?.getItem(MAP_LAYER_STORAGE_KEY);
    return value && getMapChip(value) ? value : null;
  } catch {
    return null;
  }
}

/** Writes the layer choice. Storage failures are swallowed: the choice just isn't remembered. */
export function writeStoredMapLayer(
  storage: Pick<Storage, "setItem"> | null | undefined,
  layerId: string,
): void {
  try {
    storage?.setItem(MAP_LAYER_STORAGE_KEY, layerId);
  } catch {
    // Quota or blocked storage: the layer still changes, it just isn't remembered.
  }
}
