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
import {
  AQI_SCALE,
  CLOUD_SCALE,
  FIRE_SCALE,
  RAIN_SCALE,
  TEMP_SCALE,
  WIND_SCALE,
  legendSegmentsFor,
} from "./weather-scales";

/**
 * The MapTiler key, read once and trimmed: the deployed value ends in a
 * newline. A raw newline in a URL is dropped by the URL parser, but once
 * encoded (%0A) MapTiler answers "Invalid key" (#266).
 */
export const MAPTILER_KEY = (
  process.env.NEXT_PUBLIC_MAPTILER_API_KEY ?? ""
).trim();

/** MapTiler base-map style ids, shared by the interactive map and the preview. */
export const MAPTILER_STYLE_ID_LIGHT = "streets-v2";
export const MAPTILER_STYLE_ID_DARK = "streets-v2-dark";

export function maptilerStyleId(isDark: boolean): string {
  return isDark ? MAPTILER_STYLE_ID_DARK : MAPTILER_STYLE_ID_LIGHT;
}

/**
 * The most device pixels per CSS pixel the interactive map draws at (#476).
 * A WebGL canvas costs width x height x 4 bytes, twice (the drawing buffer
 * and the one on screen) plus the GPU's own copies, so a full-screen map on a
 * 3x phone (an iPhone Pro: 1179 x 2556 pixels) held 46 MB in Chrome's
 * accounting of the renderer; at 2x it holds 20 MB. Tiles and labels stay
 * sharp at 2x, which is what most phones are anyway (2 to 2.6).
 */
export const MAP_MAX_PIXEL_RATIO = 2;

/**
 * The `pixelRatio` option to create the map with, or undefined for none. MapLibre
 * treats a set ratio as an override of `devicePixelRatio` that it keeps for the
 * map's life (only null turns it off), so a map made at 1x would stay blurry
 * after moving to a retina display. The option is therefore passed ONLY on a
 * screen above the cap, where the cap is the point; everywhere else MapLibre
 * keeps following the screen's own ratio.
 */
export function mapPixelRatioOverride(
  devicePixelRatio: number | undefined,
): number | undefined {
  const ratio = devicePixelRatio;
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return undefined;
  return ratio > MAP_MAX_PIXEL_RATIO ? MAP_MAX_PIXEL_RATIO : undefined;
}

export const MAPTILER_STYLE_LIGHT = `https://api.maptiler.com/maps/${MAPTILER_STYLE_ID_LIGHT}/style.json?key=${MAPTILER_KEY}`;
export const MAPTILER_STYLE_DARK = `https://api.maptiler.com/maps/${MAPTILER_STYLE_ID_DARK}/style.json?key=${MAPTILER_KEY}`;

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
 * The layer the map opens on, and the one it falls back to when a Tomorrow.io
 * layer is at capacity (map-capacity.ts): true-colour satellite, NASA GIBS.
 * It must be a layer that needs no paid key and no quota, so the map is never
 * blank. Rain (Tomorrow.io) was the default until 2026-11-11, when the owner
 * has no paid plan and the tiles Worker answered every rain tile with its blank
 * placeholder (#542). Not `satelliteRain`: IMERG is a 0.1 degree (about 11 km)
 * grid and draws as hard squares. `/display` keeps its own default
 * (DISPLAY_DEFAULT_LAYER in display.ts).
 */
export const DEFAULT_LAYER = "satellite";

export function getMapLayerById(id: string): MapLayer | undefined {
  return MAP_LAYERS.find((l) => l.id === id);
}

/**
 * Tomorrow.io weather overlay tiles are only served for zoom levels 1–12
 * (see the tiles Worker, which rejects z<1 or z>12 with HTTP 400).
 * Pinning the raster source's maxzoom makes MapLibre overzoom the last tile
 * when the user zooms in further instead of requesting tiles the Worker
 * rejects — which would otherwise make the overlay vanish when zoomed in.
 *
 * The cap is 8 (#266 set it to 10; lowered 2026-11-04). The forecast grids
 * behind the tiles are kilometres wide, so tiles deeper than z8 are assumed to
 * repeat the same values (not measured against the provider's data), while
 * every tile of a deeper level is a request to the provider's small shared
 * quota, one hour of cache at a time: a screen one zoom level deeper needs up
 * to four times the tiles. Zooming from 8 to 10 now asks for nothing new:
 * MapLibre enlarges the z8 tile, so a zoom cannot leave a patch of the map
 * without its overlay. The price is a coarser overlay at city zoom, an owner
 * call that the provider's capacity decides (see the tile-source decision).
 */
export const WEATHER_OVERLAY_MIN_ZOOM = 1;
export const WEATHER_OVERLAY_MAX_ZOOM = 8;

/**
 * Display size of one overlay tile, in CSS pixels. Tomorrow.io tiles are
 * 256 px images; drawing them at 512 makes MapLibre fetch tiles one zoom level
 * shallower, about a quarter as many per screen (a phone view at zoom 8 needs
 * ~4 instead of ~10). At z8 one source pixel is still ~0.6 km, finer than the
 * forecast data, so nothing visible is lost; the quota and the wait both drop.
 */
export const WEATHER_OVERLAY_TILE_SIZE = 512;

/**
 * Where the browser loads MapLibre's web worker from. maplibre-gl v6 ships
 * its worker as a separate ES module and, by default, looks for it next to
 * the bundled chunk, where webpack never puts it, so the worker fails to load
 * and every map renders blank. scripts/copy-maplibre-worker.mjs copies the
 * worker, and any module the worker imports (6.12 splits it from a shared
 * module; 6.13 and later ship it self-contained), into a per-version folder
 * before every build/dev run; MapLibreMap passes `maplibreWorkerUrl(getVersion())`
 * to setWorkerUrl() before creating a map. Keying the path by version keeps an
 * old tab's bundle paired with its own worker across deploys.
 */
export function maplibreWorkerUrl(version: string): string {
  return `/vendor/maplibre-gl/${version}/maplibre-gl-worker.mjs`;
}

/** Shared MapLibre source/layer id for the weather overlay. */
export const WEATHER_OVERLAY_ID = "weather-overlay";

/**
 * Builds the proxied tile URL template for a Tomorrow.io weather overlay layer.
 * MapLibre substitutes {z}/{x}/{y} at request time. Tiles come from the Rust
 * tiles Worker (`weather-tiles.mukoko.com`, `/v1/map-tiles`) so the Tomorrow.io
 * key stays server-side. It has its own host because one map view loads dozens
 * of tiles.
 */
/** The tiles Worker's origin. */
export const WEATHER_TILES_ORIGIN = "https://weather-tiles.mukoko.com";

export function weatherOverlayTileUrl(
  layerId: string,
  timestamp?: string,
): string {
  const base = `${WEATHER_TILES_ORIGIN}/v1/map-tiles?z={z}&x={x}&y={y}&layer=${encodeURIComponent(layerId)}`;
  if (!timestamp || timestamp === "now") return base;
  return `${base}&timestamp=${encodeURIComponent(timestamp)}`;
}

/**
 * Raster source spec for a weather overlay layer, with minzoom/maxzoom pinned
 * to the useful tile range so the overlay keeps rendering (via overzoom) at
 * high map zooms instead of silently disappearing.
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
    tileSize: WEATHER_OVERLAY_TILE_SIZE,
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

/** Chip id for the satellite fire-detection layer (a NASA GIBS layer, see map-sources.ts). */
export const WILDFIRE_LAYER_ID = "wildfire";

/**
 * What a Wildfires dot is, and is not, printed in the legend card. A VIIRS
 * thermal anomaly is heat a satellite sensed, not a report of a wildfire:
 * planned burns, gas flares and industrial heat show up the same way. FIRMS
 * says its global data are available "within 3 hours of satellite observation"
 * (earthdata.nasa.gov/data/tools/firms, read 2026-11-05), and cloud stops an
 * infrared sensor seeing the ground.
 */
export const WILDFIRE_LIMITS =
  "A dot is heat a satellite sensed, not a confirmed wildfire: it can be a planned burn, gas flare or industrial heat. Cloud can hide a real fire, and detections lag by hours.";

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
  /**
   * A layer drawn as separate marks, not a value scale (wildfire): the swatch
   * a mark is drawn in (a static `bg-` class, the same token the map's pixels
   * use) and the name printed beside it, so colour is never the only signal.
   */
  marker?: { className: string; label: string };
  /**
   * What the data cannot tell you, in plain words, shown with the legend
   * whenever the layer is active (it stays visible when the sheet collapses).
   */
  limits?: string;
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

/** "Now", "+4h", "+1d" for a whole-hour offset. */
function hourOffsetLabel(hours: number): string {
  if (hours <= 0) return "Now";
  if (hours % 24 === 0) return `+${hours / 24}d`;
  return `+${hours}h`;
}

/**
 * Model-field stops from the grid's 3-hourly UTC times (`/v1/model-grid`).
 * The grid is cached for up to 3 h, so its first time can be in the past:
 * steps that ended before `now` are dropped, the step containing `now` reads
 * "Now", and later steps are labelled by their real offset from now.
 * `timestamp` stays the grid time, so callers find the series index with
 * `times.indexOf(frame.timestamp)`.
 */
export function modelTimelineFrames(
  times: readonly string[],
  now: Date,
): TimelineFrame[] {
  const nowMs = now.getTime();
  const stepMs = TIMELINE_STEP_HOURS * 3_600_000;
  const frames: TimelineFrame[] = [];
  for (const timestamp of times) {
    const t = Date.parse(timestamp);
    if (!Number.isFinite(t) || t + stepMs <= nowMs) continue;
    frames.push({
      timestamp,
      label: hourOffsetLabel(Math.round((t - nowMs) / 3_600_000)),
    });
  }
  return frames;
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

/**
 * Legend for US AQI: the six official EPA categories (weather-scales.ts), the
 * same colours the grid fill, the bubbles and the gauge use. The note says how
 * fine the data really is: CAMS is a 0.4 degree (about 44 km) model worldwide
 * and 0.1 degree (about 11 km) over Europe, so the 13 km sample grid
 * oversamples it, and the picture is smoothed between samples, not sharper.
 */
export const AQI_LEGEND: LayerLegend = {
  unit: "US AQI",
  segments: legendSegmentsFor(AQI_SCALE),
  note: "CAMS model, grid of about 10 to 40 km",
};

/** Spacing of the model-field sample points (the Worker's 7 x 7 over +-120 km). */
const MODEL_GRID_NOTE = "Points 40 km apart, smoothed between";

/**
 * Caption for the layers painted by Tomorrow.io raster tiles (rain, temperature,
 * wind, cloud). The tiles use Tomorrow.io's own palette; the scale printed here
 * is our reference scale (weather-scales.ts), not the tile pixels. The tiles
 * Worker does not forward Tomorrow.io's `gradient` parameter yet (follow-up: mukoko-dev/mukoko-weather#387).
 */
export const TILE_NOTE = "Reference scale; map shading from Tomorrow.io";

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
      segments: legendSegmentsFor(RAIN_SCALE),
      note: TILE_NOTE,
    },
  },
  {
    id: "temperature",
    label: "Temperature",
    legend: {
      unit: "°C",
      segments: legendSegmentsFor(TEMP_SCALE),
      note: TILE_NOTE,
    },
  },
  {
    id: "windSpeed",
    label: "Wind",
    legend: {
      unit: "km/h",
      segments: legendSegmentsFor(WIND_SCALE),
      note: TILE_NOTE,
    },
  },
  {
    id: "cloudCover",
    label: "Cloud",
    legend: {
      unit: "%",
      segments: legendSegmentsFor(CLOUD_SCALE),
      note: TILE_NOTE,
    },
  },
  {
    id: "satellite",
    label: "Satellite",
    legend: {
      unit: "true colour",
      segments: [],
      note: "NOAA-20 VIIRS, about 250 m detail, one pass a day",
    },
  },
  {
    id: "satelliteRain",
    label: "Rain (satellite)",
    legend: {
      unit: "mm/h",
      segments: [],
      // \u2060 (word joiner) keeps "4–6" from breaking after the dash on a narrow sheet.
      note: "NASA IMERG, about 10 km grid, 4–\u20606 hours behind",
    },
  },
  {
    id: WILDFIRE_LAYER_ID,
    label: "Wildfires",
    legend: {
      unit: "detections",
      segments: [],
      marker: {
        className: FIRE_SCALE.bands[0].bg,
        label: FIRE_SCALE.bands[0].name,
      },
      note: "NOAA-20 VIIRS, about 375 m",
      limits: WILDFIRE_LIMITS,
    },
  },
];

/**
 * Per-model forecast fields (one blend member at a time, see MAP_MODELS).
 * Painted by MapLibreMap from /v1/model-grid cells; `token`/`from` drive
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
      segments: legendSegmentsFor(TEMP_SCALE, { withBounds: true }),
      note: MODEL_GRID_NOTE,
    },
  },
  {
    id: "modelPrecipitation",
    label: "Model rain",
    legend: {
      unit: "mm/h",
      segments: legendSegmentsFor(RAIN_SCALE, { withBounds: true }),
      note: `${MODEL_GRID_NOTE}; below 0.1 mm/h is left clear`,
    },
  },
  {
    id: "modelWind",
    label: "Model wind",
    legend: {
      unit: "km/h",
      segments: legendSegmentsFor(WIND_SCALE, { withBounds: true }),
      note: MODEL_GRID_NOTE,
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
