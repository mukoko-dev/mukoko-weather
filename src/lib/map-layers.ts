/**
 * Map layer configuration: Tomorrow.io tile overlays, NASA GIBS satellite
 * layers, the AQ grid and (behind a flag) per-model forecast fields.
 * Each Tomorrow.io layer maps to a tile API layer name and has
 * mineral-color styles following the CATEGORY_STYLES pattern. Where each
 * layer's data comes from and the credit it needs live in map-sources.ts.
 *
 * Base map tiles are served directly from MapTiler CDN (no proxy):
 * MAPTILER_STYLE_LIGHT / MAPTILER_STYLE_DARK
 */

import {
  attributionHtml,
  buildGibsSource,
  getGibsLayer,
  isGibsLayer,
  isModelLayer,
  overlayAttribution,
  satelliteFrames,
} from "./map-sources";

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
  const gibs = getGibsLayer(layerId);
  if (gibs) {
    // NASA GIBS: keyless public tiles straight from NASA (CORS-enabled), so no
    // proxy and no quota. `timestamp` is the GIBS time of the frame; "now" or
    // a missing value falls back to the newest frame by fixed latency.
    const time =
      timestamp && timestamp !== "now"
        ? timestamp
        : satelliteFrames(gibs, null, new Date()).at(-1)!.time;
    return buildGibsSource(gibs, time);
  }
  return {
    type: "raster" as const,
    tiles: [weatherOverlayTileUrl(layerId, timestamp)],
    tileSize: 256,
    minzoom: WEATHER_OVERLAY_MIN_ZOOM,
    maxzoom: WEATHER_OVERLAY_MAX_ZOOM,
    attribution: attributionHtml(overlayAttribution(layerId)),
  };
}

/** Raster opacity for a tile overlay: GIBS layers carry their own, Tomorrow.io 0.6. */
export function weatherOverlayOpacity(layerId: string): number {
  return getGibsLayer(layerId)?.opacity ?? 0.6;
}

/**
 * Source/layer id for the AQI grid overlay (Air Quality Map card). Kept
 * separate from WEATHER_OVERLAY_ID so the two can be shown together without
 * one clearing the other.
 */
export const AQI_OVERLAY_ID = "aqi-overlay";

/** Source/layer id for the per-model forecast field (model chips). */
export const MODEL_OVERLAY_ID = "model-overlay";

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
  /**
   * For layers we paint ourselves (model fields): the CSS custom property the
   * map resolves for this band (MapLibre paint cannot read var()), and the
   * value the band starts at. Must name the same colour as `className`.
   */
  token?: string;
  from?: number;
}

export interface LayerLegend {
  /** Unit shown next to the scale title, e.g. "mm/h". */
  unit: string;
  /** Empty for imagery with no value scale (true-colour satellite). */
  segments: LegendSegment[];
  /** One line under the scale, e.g. how old the imagery is. */
  note?: string;
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

/**
 * Whether the timeline is offered: Tomorrow.io rain (forecast), the GIBS
 * satellite layers (an observed loop of past frames) and the model fields
 * (the chosen model's forecast playing forward).
 */
export function layerSupportsTimeline(layerId: string): boolean {
  return (
    TIMELINE_LAYER_IDS.includes(layerId) ||
    isGibsLayer(layerId) ||
    isModelLayer(layerId)
  );
}

/** One stop on the map timeline. `timestamp` is what the layer is drawn for. */
export interface TimelineFrame {
  timestamp: string;
  label: string;
}

/** Tomorrow.io forecast stops: Now, +3h … +3d (TIMELINE_STEPS). */
export function forecastTimelineFrames(now: Date): TimelineFrame[] {
  return Array.from({ length: TIMELINE_STEPS }, (_, step) => ({
    timestamp: timelineTimestamp(step, now),
    label: timelineLabel(step),
  }));
}

/**
 * Model-field stops from the grid's 3-hourly times (`/api/py/model-grid`).
 * The first time is the current hour, so labels read Now, +3h, … like the
 * Tomorrow.io timeline.
 */
export function modelTimelineFrames(times: readonly string[]): TimelineFrame[] {
  return times.map((timestamp, step) => ({
    timestamp,
    label: timelineLabel(step),
  }));
}

/** Frame the timeline opens on: the newest image for observed loops, else Now. */
export function timelineDefaultIndex(
  layerId: string,
  frames: readonly TimelineFrame[],
): number {
  if (frames.length === 0) return 0;
  return isGibsLayer(layerId) ? frames.length - 1 : 0;
}

/** Up to `count` evenly spaced labels for under the slider (first and last included). */
export function timelineAxisLabels(
  frames: readonly TimelineFrame[],
  count = 4,
): string[] {
  if (frames.length === 0) return [];
  if (frames.length <= count) return frames.map((f) => f.label);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(frames[Math.round((i * (frames.length - 1)) / (count - 1))].label);
  }
  return out;
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
  {
    id: "satellite",
    label: "Satellite",
    legend: {
      unit: "true colour",
      segments: [],
      note: "NOAA-20 VIIRS, one pass a day",
    },
  },
  {
    id: "satelliteRain",
    label: "Rain (satellite)",
    legend: {
      unit: "mm/h",
      segments: [],
      note: "NASA IMERG, about 4–6 hours behind",
    },
  },
];

/**
 * Per-model forecast fields (one blend member at a time, see MAP_MODELS).
 * Painted by MapLibreMap from /api/py/model-grid cells; `token`/`from` drive
 * the fill colour. Kept out of MAP_CHIPS: the layer sits behind the
 * `model_map_layers` flag until the owner settles Open-Meteo's commercial
 * terms (the free API is non-commercial).
 */
export const MODEL_CHIPS: readonly MapChip[] = [
  {
    id: "modelTemperature",
    label: "Model temp",
    legend: {
      unit: "°C",
      segments: [
        {
          className: "bg-mineral-cobalt",
          token: "--color-mineral-cobalt",
          from: -Infinity,
          label: "<10",
        },
        {
          className: "bg-mineral-sodalite",
          token: "--color-mineral-sodalite",
          from: 10,
          label: "10",
        },
        {
          className: "bg-mineral-malachite",
          token: "--color-mineral-malachite",
          from: 15,
          label: "15",
        },
        {
          className: "bg-mineral-gold",
          token: "--color-mineral-gold",
          from: 22,
          label: "22",
        },
        {
          className: "bg-mineral-copper",
          token: "--color-mineral-copper",
          from: 30,
          label: "30",
        },
        {
          className: "bg-mineral-terracotta",
          token: "--color-mineral-terracotta",
          from: 38,
          label: "38+",
        },
      ],
    },
  },
  {
    id: "modelPrecipitation",
    label: "Model rain",
    legend: {
      unit: "mm/h",
      segments: [
        {
          className: "bg-mineral-cobalt",
          token: "--color-mineral-cobalt",
          from: 0.1,
          label: "0.1",
        },
        {
          className: "bg-mineral-sodalite",
          token: "--color-mineral-sodalite",
          from: 1,
          label: "1",
        },
        {
          className: "bg-mineral-tanzanite",
          token: "--color-mineral-tanzanite",
          from: 4,
          label: "4",
        },
        {
          className: "bg-mineral-terracotta",
          token: "--color-mineral-terracotta",
          from: 10,
          label: "10+",
        },
      ],
      note: "Below 0.1 mm/h is left clear",
    },
  },
  {
    id: "modelWind",
    label: "Model wind",
    legend: {
      unit: "km/h",
      segments: [
        {
          className: "bg-mineral-cobalt",
          token: "--color-mineral-cobalt",
          from: -Infinity,
          label: "0",
        },
        {
          className: "bg-mineral-malachite",
          token: "--color-mineral-malachite",
          from: 10,
          label: "10",
        },
        {
          className: "bg-mineral-gold",
          token: "--color-mineral-gold",
          from: 25,
          label: "25",
        },
        {
          className: "bg-mineral-copper",
          token: "--color-mineral-copper",
          from: 40,
          label: "40",
        },
        {
          className: "bg-mineral-terracotta",
          token: "--color-mineral-terracotta",
          from: 60,
          label: "60+",
        },
      ],
    },
  },
];

/** Every chip, including the flagged model chips (legend lookup, storage). */
const ALL_CHIPS: readonly MapChip[] = [...MAP_CHIPS, ...MODEL_CHIPS];

/** The chips to offer: the model-field chips only when their flag is on. */
export function mapChipsFor(opts: {
  modelLayers: boolean;
}): readonly MapChip[] {
  return opts.modelLayers ? ALL_CHIPS : MAP_CHIPS;
}

/**
 * Index of the legend band a value falls in (segments sorted by `from`), or
 * -1 for a value below the first band, a null value or a legend without
 * numeric bands. Pure; drives the model-field fill colour.
 */
export function legendBandIndex(
  legend: LayerLegend,
  value: number | null | undefined,
): number {
  if (value === null || value === undefined || !Number.isFinite(value))
    return -1;
  let index = -1;
  legend.segments.forEach((seg, i) => {
    if (seg.from !== undefined && value >= seg.from) index = i;
  });
  return index;
}

export { isModelLayer };

export function getMapChip(id: string): MapChip | undefined {
  return ALL_CHIPS.find((c) => c.id === id);
}

/** localStorage key for the last chosen layer. */
export const MAP_LAYER_STORAGE_KEY = "mukoko-map-layer";

/**
 * Reads the remembered layer. Returns null for a missing, unknown or
 * unreadable value (private windows and blocked storage throw), or for a layer
 * that is not in `chips` (e.g. a model chip whose flag has since been turned
 * off). Callers fall back to DEFAULT_LAYER.
 */
export function readStoredMapLayer(
  storage: Pick<Storage, "getItem"> | null | undefined,
  chips: readonly MapChip[] = MAP_CHIPS,
): string | null {
  try {
    const value = storage?.getItem(MAP_LAYER_STORAGE_KEY);
    return value && chips.some((c) => c.id === value) ? value : null;
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
