/**
 * Where every map overlay comes from, and the credit each one requires.
 *
 * This module is the single source of truth for overlay provenance:
 *
 *  - `MAP_PROVIDERS` — every data/tile provider the map can show, with the
 *    attribution text its licence requires and whether commercial use is
 *    covered on the plan we use today.
 *  - `attributionForLayer()` — the ordered credits for the active layer (base
 *    map first, then the overlay's providers). MapLibre's attribution control,
 *    the full-screen map's credit line and the tests all read this one list.
 *  - NASA GIBS satellite layers — tile URLs, the DescribeDomains time lookup and
 *    the animation frames built from it (no key; NASA data is public).
 *  - Model forecast layers — the blend members the map can draw one at a time.
 *
 * Plain data and pure functions only, so it is unit-tested without a map.
 * Research and licence notes behind each entry: issue #272
 * (refs #238, #246).
 */

/* ------------------------------------------------------------------------ *
 * Providers + attribution
 * ------------------------------------------------------------------------ */

export type MapProviderId =
  | "maptiler"
  | "osm"
  | "tomorrow"
  | "nasa-gibs"
  | "nasa-viirs"
  | "nasa-imerg"
  | "open-meteo"
  | "cams"
  | "ecmwf"
  | "noaa"
  | "dwd"
  | "eccc"
  | "meteo-france";

/**
 * Commercial use on the plan we use today:
 *  - `allowed` — the licence permits it (public domain, CC0, CC BY 4.0 data
 *    fetched from a service whose terms also allow it).
 *  - `paid-plan` — the free service we call is non-commercial; commercial use
 *    needs the provider's paid plan (an owner decision, see the issue).
 *  - `unverified` — the free tier's commercial terms are not published; ask
 *    the provider before relying on it commercially.
 */
export type CommercialUse = "allowed" | "paid-plan" | "unverified";

export interface MapProvider {
  id: MapProviderId;
  /** Short credit shown on the map, e.g. "NASA GIBS". */
  label: string;
  /** Link the credit points at (licence or provider page). */
  href: string;
  /** Licence or terms the credit satisfies, for the docs and tests. */
  licence: string;
  commercialUse: CommercialUse;
}

export const MAP_PROVIDERS: Readonly<Record<MapProviderId, MapProvider>> = {
  maptiler: {
    id: "maptiler",
    label: "© MapTiler",
    href: "https://www.maptiler.com/copyright/",
    licence: "MapTiler Cloud terms (Free plan: non-commercial)",
    commercialUse: "paid-plan",
  },
  osm: {
    id: "osm",
    label: "© OpenStreetMap contributors",
    href: "https://www.openstreetmap.org/copyright",
    licence: "ODbL 1.0",
    commercialUse: "allowed",
  },
  tomorrow: {
    id: "tomorrow",
    label: "Weather layer © Tomorrow.io",
    href: "https://www.tomorrow.io/",
    licence: "Tomorrow.io API terms (free plan)",
    commercialUse: "unverified",
  },
  "nasa-gibs": {
    id: "nasa-gibs",
    label: "Imagery: NASA GIBS (ESDIS)",
    href: "https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api",
    licence:
      "NASA Earth science data policy (no restriction; acknowledgement requested)",
    commercialUse: "allowed",
  },
  "nasa-viirs": {
    id: "nasa-viirs",
    label: "NOAA-20 VIIRS",
    href: "https://www.earthdata.nasa.gov/data/instruments/viirs",
    licence: "NASA Earth science data policy",
    commercialUse: "allowed",
  },
  "nasa-imerg": {
    id: "nasa-imerg",
    label: "NASA GPM IMERG",
    href: "https://gpm.nasa.gov/data/imerg",
    licence: "NASA Earth science data policy",
    commercialUse: "allowed",
  },
  "open-meteo": {
    id: "open-meteo",
    label: "Open-Meteo.com (CC BY 4.0)",
    href: "https://open-meteo.com/",
    licence: "CC BY 4.0 data; free API is non-commercial",
    commercialUse: "paid-plan",
  },
  cams: {
    id: "cams",
    label: "Copernicus Atmosphere Monitoring Service",
    href: "https://atmosphere.copernicus.eu/",
    licence: "Copernicus licence (free, commercial use allowed)",
    commercialUse: "allowed",
  },
  ecmwf: {
    id: "ecmwf",
    label: "ECMWF (CC BY 4.0)",
    href: "https://www.ecmwf.int/en/forecasts/datasets/open-data",
    licence: "CC BY 4.0",
    commercialUse: "allowed",
  },
  noaa: {
    id: "noaa",
    label: "NOAA",
    href: "https://www.weather.gov/disclaimer",
    licence: "US public domain",
    commercialUse: "allowed",
  },
  dwd: {
    id: "dwd",
    label: "Deutscher Wetterdienst (CC BY 4.0)",
    href: "https://www.dwd.de/EN/service/copyright/copyright_node.html",
    licence: "CC BY 4.0",
    commercialUse: "allowed",
  },
  eccc: {
    id: "eccc",
    label: "Environment and Climate Change Canada",
    href: "https://eccc-msc.github.io/open-data/licence/readme_en/",
    licence: "ECCC Data Server End-use Licence",
    commercialUse: "allowed",
  },
  "meteo-france": {
    id: "meteo-france",
    label: "Météo-France (Licence Ouverte 2.0)",
    href: "https://meteo.data.gouv.fr/",
    licence: "Etalab Licence Ouverte 2.0",
    commercialUse: "allowed",
  },
};

/** The base map's credits, shown on every map whatever the overlay. */
export const BASE_MAP_PROVIDERS: readonly MapProviderId[] = ["maptiler", "osm"];

/* ------------------------------------------------------------------------ *
 * Model forecast layers
 * ------------------------------------------------------------------------ */

/** A global model the map can draw a forecast field from. */
export interface MapModel {
  /** Open-Meteo model id (also the `selectedForecastModel` value where valid). */
  id: string;
  label: string;
  /** The agency that runs the model — its credit is required on the map. */
  provider: MapProviderId;
}

/**
 * The blend members (`weather_core::blend`), highest start weight first.
 * Ids are the ones /v1/weather accepts (`KNOWN_FORECAST_MODELS`).
 */
export const MAP_MODELS: readonly MapModel[] = [
  { id: "ecmwf_ifs", label: "ECMWF IFS", provider: "ecmwf" },
  { id: "ecmwf_aifs025_single", label: "ECMWF AIFS", provider: "ecmwf" },
  { id: "gfs_seamless", label: "GFS", provider: "noaa" },
  { id: "icon_global", label: "ICON", provider: "dwd" },
  { id: "gem_global", label: "GEM", provider: "eccc" },
  { id: "meteofrance_arpege_world", label: "ARPEGE", provider: "meteo-france" },
];

export const DEFAULT_MAP_MODEL = "ecmwf_ifs";

export function getMapModel(
  id: string | null | undefined,
): MapModel | undefined {
  return MAP_MODELS.find((m) => m.id === id);
}

/**
 * The model the map opens on for a stored `selectedForecastModel`. A blend
 * member is used as-is; the blend itself (`best_match`) and anything else open
 * on ECMWF IFS, the blend's heaviest member.
 */
export function mapModelForPreference(
  preference: string | null | undefined,
): string {
  return getMapModel(preference)?.id ?? DEFAULT_MAP_MODEL;
}

/** Model-field variables the map can draw. */
export type ModelVariable = "temperature" | "precipitation" | "wind";

/** Chip id → model variable for the model-field chips. */
export const MODEL_LAYER_VARIABLES: Readonly<Record<string, ModelVariable>> = {
  modelTemperature: "temperature",
  modelPrecipitation: "precipitation",
  modelWind: "wind",
};

export function isModelLayer(layerId: string): boolean {
  return layerId in MODEL_LAYER_VARIABLES;
}

/* ------------------------------------------------------------------------ *
 * Layer → providers
 * ------------------------------------------------------------------------ */

/**
 * Overlay providers per chip id. Model-field chips are resolved separately
 * (their credit depends on the chosen model).
 */
const LAYER_PROVIDERS: Readonly<Record<string, readonly MapProviderId[]>> = {
  airQuality: ["cams", "open-meteo"],
  precipitationIntensity: ["tomorrow"],
  temperature: ["tomorrow"],
  windSpeed: ["tomorrow"],
  cloudCover: ["tomorrow"],
  humidity: ["tomorrow"],
  satellite: ["nasa-gibs", "nasa-viirs"],
  satelliteRain: ["nasa-gibs", "nasa-imerg"],
};

/**
 * Ordered, de-duplicated credits for a layer: base map first, then the
 * overlay. Unknown or empty layers credit only the base map.
 */
export function attributionForLayer(
  layerId: string | null | undefined,
  modelId?: string | null,
): MapProvider[] {
  const ids: MapProviderId[] = [...BASE_MAP_PROVIDERS];
  if (layerId && isModelLayer(layerId)) {
    const model = getMapModel(modelId) ?? getMapModel(DEFAULT_MAP_MODEL)!;
    ids.push(model.provider, "open-meteo");
  } else if (layerId) {
    ids.push(...(LAYER_PROVIDERS[layerId] ?? []));
  }
  return [...new Set(ids)].map((id) => MAP_PROVIDERS[id]);
}

/** Overlay-only credits (no base map) — for a tile source's `attribution`. */
export function overlayAttribution(
  layerId: string | null | undefined,
  modelId?: string | null,
): MapProvider[] {
  return attributionForLayer(layerId, modelId).filter(
    (p) => !BASE_MAP_PROVIDERS.includes(p.id),
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * HTML for MapLibre's attribution control (it renders the string as HTML).
 * Every value comes from the static MAP_PROVIDERS table and is escaped anyway.
 */
export function attributionHtml(providers: readonly MapProvider[]): string {
  return providers
    .map(
      (p) =>
        `<a href="${escapeHtml(p.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.label)}</a>`,
    )
    .join(" · ");
}

/**
 * Drops the `attribution` every source of a style JSON carries. MapTiler's
 * styles credit "MapTiler" and "OpenStreetMap contributors" on their own vector
 * source, and MapLibre's control renders those next to our custom attribution;
 * the strings differ slightly, so MapLibre cannot de-duplicate them and each
 * credit appeared twice. The base-map credits come from MAP_PROVIDERS only
 * (BASE_MAP_PROVIDERS), so the style's own copies are removed. Pass as
 * `transformStyle` on the Map constructor and on `setStyle`.
 */
export function withoutStyleAttributions<
  S extends { sources?: Record<string, unknown> },
>(style: S): S {
  if (!style.sources) return style;
  const sources: Record<string, unknown> = {};
  for (const [id, source] of Object.entries(style.sources)) {
    if (source && typeof source === "object" && "attribution" in source) {
      const rest = { ...(source as Record<string, unknown>) };
      delete rest.attribution;
      sources[id] = rest;
    } else {
      sources[id] = source;
    }
  }
  return { ...style, sources };
}

/* ------------------------------------------------------------------------ *
 * NASA GIBS satellite layers
 * ------------------------------------------------------------------------ */

export const GIBS_WMTS_ORIGIN = "https://gibs.earthdata.nasa.gov";

export interface GibsLayer {
  /** Chip id in map-layers.ts. */
  chipId: string;
  /** GIBS layer identifier (WMTS capabilities). */
  gibsId: string;
  /** Web Mercator tile matrix set; its level is the native max zoom. */
  matrixSet: string;
  maxZoom: number;
  ext: "jpg" | "png";
  /** Time step between frames: one day or 30 minutes. */
  cadence: "P1D" | "PT30M";
  /** Frames in the animation loop. */
  frames: number;
  /**
   * Fallback latency when the time lookup fails: the newest frame is assumed
   * to be this many hours old. Generous on purpose — a frame that does not
   * exist yet 404s.
   */
  fallbackLatencyHours: number;
  /** Raster opacity. True colour is opaque imagery; precipitation is an overlay. */
  opacity: number;
}

/**
 * Checked live against GIBS WMTS capabilities on 2026-10-11:
 *  - VIIRS NOAA-20 true colour: daily, JPEG, Level 9 (~300 m at z9). One
 *    afternoon pass a day, so the loop steps day by day.
 *  - IMERG 30-minute precipitation rate: PNG, Level 6. Early run, about 4–6 h
 *    behind real time; the loop is the last 6 hours of observed rain.
 * GIBS has no Meteosat layer; GOES-East only reaches West Africa's edge.
 */
export const GIBS_LAYERS: Readonly<Record<string, GibsLayer>> = {
  satellite: {
    chipId: "satellite",
    gibsId: "VIIRS_NOAA20_CorrectedReflectance_TrueColor",
    matrixSet: "GoogleMapsCompatible_Level9",
    maxZoom: 9,
    ext: "jpg",
    cadence: "P1D",
    frames: 7,
    fallbackLatencyHours: 24,
    opacity: 0.9,
  },
  satelliteRain: {
    chipId: "satelliteRain",
    gibsId: "IMERG_Precipitation_Rate_30min",
    matrixSet: "GoogleMapsCompatible_Level6",
    maxZoom: 6,
    ext: "png",
    cadence: "PT30M",
    frames: 13,
    fallbackLatencyHours: 8,
    opacity: 0.75,
  },
};

export function getGibsLayer(layerId: string): GibsLayer | undefined {
  return GIBS_LAYERS[layerId];
}

export function isGibsLayer(layerId: string): boolean {
  return layerId in GIBS_LAYERS;
}

/** XYZ tile template for a GIBS layer at one time (MapLibre fills {z}/{x}/{y}). */
export function gibsTileUrl(layer: GibsLayer, time: string): string {
  return `${GIBS_WMTS_ORIGIN}/wmts/epsg3857/best/${layer.gibsId}/default/${encodeURIComponent(time)}/${layer.matrixSet}/{z}/{y}/{x}.${layer.ext}`;
}

/** YYYY-MM-DD in UTC. */
function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * GIBS DescribeDomains URL: the layer's available times between two dates.
 * A tiny XML document (CORS-enabled), unlike the 6 MB capabilities file.
 */
export function gibsDomainsUrl(layer: GibsLayer, now: Date): string {
  const from = new Date(now.getTime() - 10 * 86_400_000);
  const to = new Date(now.getTime() + 86_400_000);
  return `${GIBS_WMTS_ORIGIN}/wmts/epsg3857/best/1.0.0/${layer.gibsId}/default/${layer.matrixSet}/all/${utcDate(from)}--${utcDate(to)}.xml`;
}

/** One `start/end/period` interval from a DescribeDomains `<Domain>`. */
export interface TimeInterval {
  start: number;
  end: number;
  periodMs: number;
}

function periodMs(period: string): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(period);
  if (!m || period === "P" || period === "PT") return null;
  const ms =
    Number(m[1] ?? 0) * 86_400_000 +
    Number(m[2] ?? 0) * 3_600_000 +
    Number(m[3] ?? 0) * 60_000;
  return ms > 0 ? ms : null;
}

function parseTime(value: string): number | null {
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Parses the `<Domain>` of a GIBS DescribeDomains response into intervals.
 * The domain is a comma-separated list of `start/end/period` triples (or bare
 * instants). Malformed entries are skipped; an unreadable document yields [].
 */
export function parseGibsDomains(xml: string): TimeInterval[] {
  const match = /<Domain>([^<]*)<\/Domain>/.exec(xml);
  if (!match) return [];
  const out: TimeInterval[] = [];
  for (const raw of match[1].split(",")) {
    const parts = raw.trim().split("/");
    if (parts.length === 1) {
      const t = parseTime(parts[0]);
      if (t !== null) out.push({ start: t, end: t, periodMs: 0 });
      continue;
    }
    if (parts.length !== 3) continue;
    const start = parseTime(parts[0]);
    const end = parseTime(parts[1]);
    const step = periodMs(parts[2]);
    if (start === null || end === null || step === null || end < start)
      continue;
    out.push({ start, end, periodMs: step });
  }
  return out;
}

/** The GIBS time string for an instant at a layer's cadence. */
export function gibsTimeString(layer: GibsLayer, t: number): string {
  const iso = new Date(t).toISOString();
  return layer.cadence === "P1D" ? iso.slice(0, 10) : `${iso.slice(0, 19)}Z`;
}

/** One animation frame: the GIBS time and a short label relative to now. */
export interface SatelliteFrame {
  time: string;
  label: string;
}

/**
 * Daily imagery for "today" is a partial mosaic until the afternoon passes
 * over Africa have been processed (~13:30 local overpass + ~3 h latency), so
 * today's frame is only offered from 18:00 UTC.
 */
export const DAILY_COMPLETE_HOUR_UTC = 18;

function frameLabel(layer: GibsLayer, t: number, now: Date): string {
  if (layer.cadence === "P1D") {
    const days = Math.round(
      (Date.parse(`${utcDate(now)}T00:00:00Z`) - t) / 86_400_000,
    );
    if (days <= 0) return "Today";
    if (days === 1) return "Yesterday";
    return `−${days}d`;
  }
  const minutes = Math.max(0, Math.round((now.getTime() - t) / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `−${h}h` : `−${h}h${String(m).padStart(2, "0")}`;
}

/** Every available instant inside the intervals, newest last, capped to `limit`. */
function latestInstants(
  intervals: readonly TimeInterval[],
  limit: number,
  notAfter: number,
): number[] {
  const out: number[] = [];
  const sorted = [...intervals].sort((a, b) => b.end - a.end);
  for (const iv of sorted) {
    let t = Math.min(iv.end, notAfter);
    if (iv.periodMs > 0) {
      // Snap onto the interval's grid.
      t = iv.start + Math.floor((t - iv.start) / iv.periodMs) * iv.periodMs;
    }
    while (t >= iv.start && out.length < limit) {
      if (t <= notAfter && !out.includes(t)) out.push(t);
      if (iv.periodMs <= 0) break;
      t -= iv.periodMs;
    }
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => a - b);
}

/**
 * Animation frames for a GIBS layer, oldest first, ending on the newest frame
 * GIBS reports (or, without a domain, on `now − fallbackLatencyHours`).
 * Future instants are never returned — GIBS answers them with 404.
 */
export function satelliteFrames(
  layer: GibsLayer,
  intervals: readonly TimeInterval[] | null,
  now: Date,
): SatelliteFrame[] {
  let notAfter = now.getTime();
  if (layer.cadence === "P1D") {
    const today = Date.parse(`${utcDate(now)}T00:00:00Z`);
    notAfter =
      now.getUTCHours() >= DAILY_COMPLETE_HOUR_UTC ? today : today - 86_400_000;
  }

  let instants: number[];
  if (intervals && intervals.length > 0) {
    instants = latestInstants(intervals, layer.frames, notAfter);
  } else {
    instants = [];
  }

  if (instants.length === 0) {
    const stepMs = layer.cadence === "P1D" ? 86_400_000 : 30 * 60_000;
    let newest = Math.min(
      notAfter,
      now.getTime() - layer.fallbackLatencyHours * 3_600_000,
    );
    newest = Math.floor(newest / stepMs) * stepMs;
    instants = Array.from(
      { length: layer.frames },
      (_, i) => newest - (layer.frames - 1 - i) * stepMs,
    );
  }

  return instants.map((t) => ({
    time: gibsTimeString(layer, t),
    label: frameLabel(layer, t, now),
  }));
}

/** Raster source spec for a GIBS layer at one frame. */
export function buildGibsSource(layer: GibsLayer, time: string) {
  return {
    type: "raster" as const,
    tiles: [gibsTileUrl(layer, time)],
    tileSize: 256,
    minzoom: 0,
    maxzoom: layer.maxZoom,
    attribution: attributionHtml(overlayAttribution(layer.chipId)),
  };
}

/**
 * Fetches the layer's available times from GIBS. Returns null on any failure
 * (network, non-200, unreadable XML) — callers fall back to the fixed latency.
 */
export async function fetchGibsDomains(
  layer: GibsLayer,
  now: Date,
  signal?: AbortSignal,
): Promise<TimeInterval[] | null> {
  try {
    const res = await fetch(gibsDomainsUrl(layer, now), { signal });
    if (!res.ok) return null;
    const intervals = parseGibsDomains(await res.text());
    return intervals.length > 0 ? intervals : null;
  } catch {
    return null;
  }
}
