"use client";

import { useEffect, useRef, useState } from "react";
import type {
  Map as MapLibreGLMap,
  Marker,
  GeoJSONSource,
  ExpressionSpecification,
} from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import { useAppStore } from "@/lib/store";
import { resolveTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { resolveColor } from "@/components/ui/chart";
import {
  MAPTILER_KEY,
  maptilerStyleId,
  maplibreWorkerUrl,
  WEATHER_OVERLAY_ID,
  AQI_OVERLAY_ID,
  MODEL_OVERLAY_ID,
  buildWeatherOverlaySource,
  weatherOverlayOpacity,
} from "@/lib/map-layers";
import { overlayFrameId, planOverlayFrames } from "@/lib/overlay-frames";
import {
  BASE_MAP_PROVIDERS,
  MAP_PROVIDERS,
  attributionHtml,
  overlayAttribution,
  withoutStyleAttributions,
} from "@/lib/map-sources";
import {
  AQI_BANDS,
  AQI_BAND_BG_CLASS,
  AQI_BAND_LABELS,
  AQI_BAND_SEVERITY_TOKEN,
  type AqBubble,
} from "@/lib/aq-grid";

export function getMapTilerStyle(isDark: boolean): string {
  const style = maptilerStyleId(isDark);
  return `https://api.maptiler.com/maps/${style}/style.json?key=${MAPTILER_KEY}`;
}

/**
 * Classifies a MapLibre `error` event as either a weather-overlay failure or a
 * base-map failure (style/base-tile/source load error). Weather overlay frames
 * are the only sources registered under `overlayId` (or `overlayId@…`, one per
 * timeline frame), so any error not tied to them — including a failed
 * style.json fetch (expired/over-quota MapTiler key → 403/429) which carries no
 * `sourceId` — is treated as a base-map failure. Exported for testing.
 */
export function classifyMapError(
  e: { error?: unknown; sourceId?: string },
  overlayId: string | readonly string[],
): "overlay" | "base" {
  const id = e?.sourceId;
  if (id === undefined) return "base";
  const ids = typeof overlayId === "string" ? [overlayId] : overlayId;
  return ids.some((o) => id === o || id.startsWith(`${o}@`))
    ? "overlay"
    : "base";
}

/** Mutable frame bookkeeping for one map instance (see overlay-frames.ts). */
interface FrameState {
  /** Frame ids currently on the map. */
  present: Set<string>;
  /** Frame shown at full opacity. */
  active: string | null;
  /** Frame the user asked for. */
  want: string | null;
  /** Timestamp of each frame, for the loaded callback. */
  timestamps: Record<string, string>;
  /** Opacity of the shown frame for the layer it was built for. */
  opacity: number;
}

function newFrameState(): FrameState {
  return {
    present: new Set(),
    active: null,
    want: null,
    timestamps: {},
    opacity: weatherOverlayOpacity(""),
  };
}

function removeFrame(map: MapLibreGLMap, state: FrameState, id: string) {
  if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(id)) map.removeSource(id);
  state.present.delete(id);
  delete state.timestamps[id];
}

/** True once every in-view tile of the frame has loaded (or errored). */
function frameLoaded(map: MapLibreGLMap, id: string): boolean {
  try {
    return !!map.getSource(id) && map.isSourceLoaded(id);
  } catch {
    return false;
  }
}

/** Every source we add on top of the base style; their errors are overlay errors. */
const OVERLAY_SOURCE_IDS = [
  WEATHER_OVERLAY_ID,
  AQI_OVERLAY_ID,
  MODEL_OVERLAY_ID,
] as const;

/**
 * How long a new timeline frame may load hidden before it is shown anyway,
 * tile by tile. Past this the visible frame would no longer match the
 * timeline label, which is worse than a frame that is still filling in.
 */
const FRAME_SWAP_TIMEOUT_MS = 2500;

/**
 * Shows `state.want` if it has loaded (or `force` is set): raises it to full
 * opacity and removes the frame it replaces. Returns the timestamp shown once
 * the frame is complete, or null while it is still loading.
 */
function swapToWantIfLoaded(
  map: MapLibreGLMap,
  state: FrameState,
  keep: string | null,
  force = false,
): string | null {
  const want = state.want;
  if (!want || !state.present.has(want)) return null;
  const loaded = frameLoaded(map, want);
  if (!loaded && !force) return null;
  if (state.active !== want) {
    map.setPaintProperty(want, "raster-opacity", state.opacity);
    const old = state.active;
    state.active = want;
    if (old && old !== keep) removeFrame(map, state, old);
    else if (old) map.setPaintProperty(old, "raster-opacity", 0);
  }
  return loaded ? (state.timestamps[want] ?? null) : null;
}

/**
 * Brings the weather overlay frames in line with the selection: adds the
 * wanted frame (and an optional preload) as their own raster sources, keeps
 * the visible frame on screen until the wanted one loads, and removes stale
 * frames. A null layer clears the overlay. A style switch wipes every source,
 * so the restore path starts from a fresh `FrameState`.
 */
function syncWeatherFrames(
  map: MapLibreGLMap,
  state: FrameState,
  layer: string | null,
  timestamp: string,
  prefetchTimestamp: string | null,
): string | null {
  const want = layer ? overlayFrameId(layer, timestamp) : null;
  const prefetch =
    layer && prefetchTimestamp && prefetchTimestamp !== timestamp
      ? overlayFrameId(layer, prefetchTimestamp)
      : null;
  const plan = planOverlayFrames({
    present: [...state.present],
    active: state.active,
    want,
    prefetch,
  });
  for (const id of plan.remove) {
    removeFrame(map, state, id);
    if (state.active === id) state.active = null;
  }
  if (state.active && !state.present.has(state.active)) state.active = null;
  state.want = want;
  if (!layer || !want) return null;
  state.opacity = weatherOverlayOpacity(layer);

  for (const id of plan.add) {
    const ts = id === want ? timestamp : (prefetchTimestamp ?? "now");
    const visible = id === want && plan.showWantNow;
    map.addSource(id, buildWeatherOverlaySource(layer, ts));
    map.addLayer({
      id,
      type: "raster",
      source: id,
      paint: {
        "raster-opacity": visible ? state.opacity : 0,
        "raster-opacity-transition": { duration: 0, delay: 0 },
      },
    });
    state.present.add(id);
    state.timestamps[id] = ts;
  }
  if (plan.showWantNow) {
    // Nothing on screen yet: the first frame paints tile by tile.
    map.setPaintProperty(want, "raster-opacity", state.opacity);
    state.active = want;
  } else if (
    prefetch &&
    state.present.has(prefetch) &&
    prefetch !== state.active
  ) {
    map.setPaintProperty(prefetch, "raster-opacity", 0);
  }
  return swapToWantIfLoaded(map, state, prefetch);
}

/** Overlay props as the map's event handlers see them (latest render). */
interface OverlayProps {
  layer: string | null;
  timestamp: string;
  prefetch: string | null;
  onLoaded?: (timestamp: string) => void;
}

/** Applies the overlay props to the frames and reports a loaded frame. */
function syncFramesFrom(
  map: MapLibreGLMap,
  state: FrameState,
  props: OverlayProps,
) {
  const shown = syncWeatherFrames(
    map,
    state,
    props.layer,
    props.timestamp,
    props.prefetch,
  );
  if (shown) props.onLoaded?.(shown);
}

/**
 * A frame's tiles came in (or failed), the map went idle, or the swap timeout
 * passed (`force`): swap the wanted frame in if it is complete, or regardless
 * when forced, and report it once complete.
 */
function settleFrame(
  map: MapLibreGLMap,
  state: FrameState,
  props: OverlayProps,
  force = false,
) {
  const keep =
    props.layer && props.prefetch
      ? overlayFrameId(props.layer, props.prefetch)
      : null;
  const shown = swapToWantIfLoaded(map, state, keep, force);
  if (shown) props.onLoaded?.(shown);
}

/**
 * Renders AQI bubbles as HTML markers. Each is a severity-coloured disc with
 * its US AQI value, so the number reads without a symbol layer or glyphs. The
 * centre ("my location") bubble is larger. Returns the markers so the caller
 * can remove them on the next render.
 */
function renderAqiBubbles(
  map: MapLibreGLMap,
  MarkerCtor: typeof Marker,
  bubbles: readonly AqBubble[],
): Marker[] {
  return bubbles.map((b) => {
    const el = document.createElement("div");
    el.className = cn(
      "flex items-center justify-center rounded-full font-semibold text-severity-fg shadow-md ring-2 ring-surface-card",
      AQI_BAND_BG_CLASS[b.band],
      b.isCenter ? "size-12 text-sm" : "size-8 text-xs",
    );
    el.setAttribute("role", "img");
    el.setAttribute(
      "aria-label",
      `US AQI ${b.aqi}, ${AQI_BAND_LABELS[b.band]}${b.isCenter ? ", your location" : ""}`,
    );
    el.textContent = String(b.aqi);
    return new MarkerCtor({ element: el }).setLngLat([b.lon, b.lat]).addTo(map);
  });
}

/**
 * Fill colour per AQI band, as a MapLibre `match` expression. Colours come from
 * the resolved severity tokens (paint values cannot read var()), so they follow
 * the light/dark theme. Unknown bands fall back to the tertiary text token.
 */
function aqiFillColorExpression(): ExpressionSpecification {
  // Flat [band, colour, band, colour, …] pairs after the lookup, then fallback.
  const pairs: string[] = [];
  for (const band of AQI_BANDS) {
    pairs.push(band, resolveColor(`var(${AQI_BAND_SEVERITY_TOKEN[band]})`));
  }
  const expression: unknown[] = [
    "match",
    ["get", "band"],
    ...pairs,
    resolveColor("var(--color-text-tertiary)"),
  ];
  return expression as ExpressionSpecification;
}

/**
 * Adds (or replaces) the AQI grid overlay: one semi-transparent fill per grid
 * cell, coloured by its `band` property. The layer is inserted beneath the
 * first symbol layer so road and place labels stay readable over the colour.
 * Idempotent; a null/undefined collection just clears the overlay.
 */
function applyAqiOverlay(
  map: MapLibreGLMap,
  data: FeatureCollection | null | undefined,
) {
  if (map.getLayer(AQI_OVERLAY_ID)) map.removeLayer(AQI_OVERLAY_ID);
  if (map.getSource(AQI_OVERLAY_ID)) map.removeSource(AQI_OVERLAY_ID);

  if (!data) return;

  const beforeId = map
    .getStyle()
    ?.layers?.find((layer) => layer.type === "symbol")?.id;

  map.addSource(AQI_OVERLAY_ID, {
    type: "geojson",
    data,
    attribution: attributionHtml(overlayAttribution("airQuality")),
  });
  map.addLayer(
    {
      id: AQI_OVERLAY_ID,
      type: "fill",
      source: AQI_OVERLAY_ID,
      paint: {
        "fill-color": aqiFillColorExpression(),
        "fill-opacity": 0.55,
      },
    },
    beforeId,
  );
}

/**
 * A forecast field painted from grid cells (model layers): each feature
 * carries a `band` index into `tokens` (CSS custom properties, resolved here
 * because paint values cannot read var()). `attribution` credits the model.
 */
export interface FieldOverlay {
  data: FeatureCollection;
  tokens: readonly string[];
  attribution: string;
}

/**
 * Adds (or replaces) the model-field overlay beneath the first symbol layer,
 * like the AQI grid. Idempotent; null clears it.
 */
/** Colour tokens + credit each map's field overlay was built with. */
const fieldStyleOf = new WeakMap<MapLibreGLMap, string>();

function applyFieldOverlay(
  map: MapLibreGLMap,
  overlay: FieldOverlay | null | undefined,
) {
  const style = overlay
    ? `${overlay.tokens.join(",")}|${overlay.attribution}`
    : "";
  // Same palette and credit (a timeline step): swap the cells in place.
  const existing = map.getSource(MODEL_OVERLAY_ID) as GeoJSONSource | undefined;
  if (
    overlay &&
    existing &&
    map.getLayer(MODEL_OVERLAY_ID) &&
    fieldStyleOf.get(map) === style
  ) {
    existing.setData(overlay.data);
    return;
  }

  if (map.getLayer(MODEL_OVERLAY_ID)) map.removeLayer(MODEL_OVERLAY_ID);
  if (map.getSource(MODEL_OVERLAY_ID)) map.removeSource(MODEL_OVERLAY_ID);
  fieldStyleOf.delete(map);
  if (!overlay || overlay.tokens.length === 0) return;

  const beforeId = map
    .getStyle()
    ?.layers?.find((layer) => layer.type === "symbol")?.id;
  const pairs: (number | string)[] = [];
  overlay.tokens.forEach((token, i) => {
    pairs.push(i, resolveColor(`var(${token})`));
  });
  const fillColor = [
    "match",
    ["get", "band"],
    ...pairs,
    resolveColor("var(--color-text-tertiary)"),
  ] as unknown as ExpressionSpecification;

  map.addSource(MODEL_OVERLAY_ID, {
    type: "geojson",
    data: overlay.data,
    attribution: overlay.attribution,
  });
  map.addLayer(
    {
      id: MODEL_OVERLAY_ID,
      type: "fill",
      source: MODEL_OVERLAY_ID,
      paint: { "fill-color": fillColor, "fill-opacity": 0.5 },
    },
    beforeId,
  );
  fieldStyleOf.set(map, style);
}

interface MapLibreMapProps {
  lat: number;
  lon: number;
  zoom?: number;
  interactive?: boolean;
  weatherLayer?: string | null;
  /**
   * Forecast time for the weather tiles: "now" or an hourly
   * `YYYY-MM-DDTHH:00:00Z` (see timelineTimestamp). Ignored when no layer is set.
   */
  weatherTimestamp?: string;
  /**
   * A second forecast time to preload hidden (usually the next timeline stop),
   * so stepping to it shows a frame that has already loaded. Null for none —
   * every preload costs real tile requests against a small upstream quota.
   */
  weatherPrefetchTimestamp?: string | null;
  /**
   * Called with the timestamp of the overlay frame once all of its in-view
   * tiles have loaded and it is on screen. Timeline playback waits for it.
   */
  onWeatherFrameLoaded?: (timestamp: string) => void;
  /**
   * AQI bubbles (see aqBubbles). Rendered as HTML markers over the map. Omit
   * or pass null for none.
   */
  aqiBubbles?: readonly AqBubble[] | null;
  /**
   * Show MapLibre's zoom buttons (top-right). Pages with their own top-right
   * controls turn this off; pinch and scroll zoom still work. Default true.
   */
  navigationControl?: boolean;
  /**
   * Add MapLibre's attribution control (bottom-left). A page whose bottom sheet
   * covers that corner can turn it off and print the MapTiler/OpenStreetMap
   * credits itself. Default true.
   */
  attributionControl?: boolean;
  /**
   * Optional AQI grid (cells with `band` properties, see `gridToGeoJSON`).
   * Rendered as a fill layer beneath map labels. Omit for no overlay.
   */
  aqiOverlay?: FeatureCollection | null;
  /** Optional model forecast field (see FieldOverlay). Omit for none. */
  fieldOverlay?: FieldOverlay | null;
  className?: string;
}

export function MapLibreMap({
  lat,
  lon,
  zoom = 8,
  interactive = true,
  weatherLayer = null,
  weatherTimestamp = "now",
  weatherPrefetchTimestamp = null,
  onWeatherFrameLoaded,
  aqiBubbles = null,
  navigationControl = true,
  attributionControl = true,
  aqiOverlay = null,
  fieldOverlay = null,
  className = "h-full w-full",
}: MapLibreMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreGLMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  // Restores the marker + weather overlay after a style switch wipes them.
  // Set inside the mount effect (needs the async-imported Marker constructor).
  const restoreRef = useRef<(() => void) | null>(null);
  // Latest overlay props, in a ref so async callbacks ("style.load" restore,
  // "sourcedata") always apply the current selection (see syncFramesFrom).
  const overlayPropsRef = useRef<OverlayProps>({
    layer: weatherLayer,
    timestamp: weatherTimestamp,
    prefetch: weatherPrefetchTimestamp,
    onLoaded: onWeatherFrameLoaded,
  });
  overlayPropsRef.current = {
    layer: weatherLayer,
    timestamp: weatherTimestamp,
    prefetch: weatherPrefetchTimestamp,
    onLoaded: onWeatherFrameLoaded,
  };
  // Timeline frames on the map (see overlay-frames.ts). Reset on style switch.
  const framesRef = useRef<FrameState>(newFrameState());
  // True once the current style JSON has been applied (MapLibre "style.load").
  // Sources and layers can be added from then on; waiting for "load" or
  // "idle" instead means waiting for every base tile, sprite and glyph.
  const styleReadyRef = useRef(false);
  // AQI bubbles: markers are created with the Marker constructor, which is only
  // available after the async import, so it is held in a ref from mount.
  const bubbleMarkersRef = useRef<Marker[]>([]);
  const markerCtorRef = useRef<typeof Marker | null>(null);
  const aqiBubblesRef = useRef<readonly AqBubble[] | null>(aqiBubbles);
  aqiBubblesRef.current = aqiBubbles;
  // Same pattern for the AQI overlay: restore() reads the latest collection.
  const aqiOverlayRef = useRef<FeatureCollection | null>(aqiOverlay);
  aqiOverlayRef.current = aqiOverlay;
  const fieldOverlayRef = useRef<FieldOverlay | null>(fieldOverlay);
  fieldOverlayRef.current = fieldOverlay;
  const [overlayError, setOverlayError] = useState(false);
  // Dedupes overlay tile-load logging. A single map view fires one `error` event
  // per failed raster tile (≈10 per pan/zoom), so without this guard a transient
  // decode failure spams the console 10× and re-runs the handler needlessly. We
  // log at most once per layer selection; reset when the layer changes below.
  const overlayErrorLoggedRef = useRef(false);
  // Set when the base map style / base tiles fail to load at runtime (e.g. an
  // expired or over-quota MapTiler key returning 403/429). Without this the map
  // renders as a silent blank/partial surface with no feedback.
  const [baseMapError, setBaseMapError] = useState(false);
  // The MapTiler base tiles load client-side directly from the CDN using
  // NEXT_PUBLIC_MAPTILER_API_KEY. When the key is missing the style request
  // fails and the map renders as a blank surface — surface that explicitly
  // instead of a silent empty area so it's obvious the key needs configuring.
  const [baseMapMissingKey] = useState(() => !MAPTILER_KEY);
  const theme = useAppStore((s) => s.theme);

  const isDark = resolveTheme(theme) === "dark";

  useEffect(() => {
    if (!containerRef.current) return;
    // Without a MapTiler key the base style can't load — skip init and show the
    // notice below rather than letting MapLibre repeatedly fail on a broken URL.
    if (baseMapMissingKey) return;

    // Guard against the async import resolving after unmount (doubled under
    // React StrictMode) — a Map created past unmount would otherwise leak,
    // never getting `.remove()`d by the cleanup below.
    let cancelled = false;

    import("maplibre-gl").then(
      ({
        Map,
        Marker: MLMarker,
        NavigationControl,
        AttributionControl,
        setWorkerUrl,
        getVersion,
      }) => {
        if (cancelled || !containerRef.current) return;
        // Must run before the first Map is created: the default worker URL
        // points at a file webpack never emits (see maplibreWorkerUrl).
        setWorkerUrl(
          new URL(maplibreWorkerUrl(getVersion()), window.location.href).href,
        );
        import("maplibre-gl/dist/maplibre-gl.css");

        const map: MapLibreGLMap = new Map({
          container: containerRef.current,
          center: [lon, lat],
          zoom,
          interactive,
          // The default attribution control sits bottom-right, which would collide
          // with the bottom-right overlay layer switcher. Disable it here and re-add
          // it explicitly at bottom-left below.
          attributionControl: false,
        });

        // MapOptions has no transformStyle, so the style is set right after
        // construction (no style yet → no first-style race). Credits come from
        // map-sources.ts only; the style's own source attribution would render
        // a second copy of MapTiler / OSM.
        map.setStyle(getMapTilerStyle(isDark), {
          transformStyle: (_previous, next) => withoutStyleAttributions(next),
        });

        // Unmounted while the Map was constructing — tear it down immediately.
        if (cancelled) {
          map.remove();
          return;
        }

        mapRef.current = map;
        markerCtorRef.current = MLMarker;

        if (attributionControl) {
          map.addControl(
            // Base-map credits here; each overlay source carries its own
            // `attribution` (map-sources.ts), which the control adds while
            // that overlay is on the map.
            new AttributionControl({
              customAttribution: attributionHtml(
                BASE_MAP_PROVIDERS.map((id) => MAP_PROVIDERS[id]),
              ),
            }),
            "bottom-left",
          );
        }

        if (interactive && navigationControl) {
          map.addControl(
            new NavigationControl({ showCompass: false }),
            "top-right",
          );
        }

        const restore = () => {
          markerRef.current?.remove();
          // Resolved here (not at module scope) so each restore — including the
          // post-theme-switch one — picks up the current theme's primary token.
          markerRef.current = new MLMarker({
            color: resolveColor("var(--color-primary)"),
          })
            .setLngLat([lon, lat])
            .addTo(map);
          // A style switch removes every frame source; drop any survivor and
          // start the frame bookkeeping from scratch.
          styleReadyRef.current = true;
          const previous = framesRef.current;
          for (const id of previous.present) removeFrame(map, previous, id);
          framesRef.current = newFrameState();
          syncFramesFrom(map, framesRef.current, overlayPropsRef.current);
          applyAqiOverlay(map, aqiOverlayRef.current);
          applyFieldOverlay(map, fieldOverlayRef.current);
          bubbleMarkersRef.current.forEach((m) => m.remove());
          bubbleMarkersRef.current = aqiBubblesRef.current
            ? renderAqiBubbles(map, MLMarker, aqiBubblesRef.current)
            : [];
        };
        restoreRef.current = restore;

        // "style.load" fires as soon as the style JSON is applied (and again
        // after a theme switch), so overlay tiles are requested alongside the
        // base tiles instead of after the first full render ("load").
        map.on("style.load", restore);

        // A frame finished loading: swap it in and tell the page (playback).
        map.on("sourcedata", (e: { sourceId?: string }) => {
          const state = framesRef.current;
          if (!e?.sourceId || e.sourceId !== state.want) return;
          settleFrame(map, state, overlayPropsRef.current);
        });
        // A frame that needs no tiles (or whose last tile fails without an
        // event) completes with no "sourcedata" for it; "idle" catches that.
        map.on("idle", () => {
          settleFrame(map, framesRef.current, overlayPropsRef.current);
        });

        // Surface tile/style failures (missing/expired API key → 403/503, rate
        // limit → 429, upstream error) instead of showing a silent blank map.
        // Overlay errors show the transient overlay notice; base-map/style errors
        // show the "Base map unavailable" notice so a blank base map is never
        // silent.
        map.on("error", (e: { error?: unknown; sourceId?: string }) => {
          if (classifyMapError(e, OVERLAY_SOURCE_IDS) === "overlay") {
            const state = framesRef.current;
            // An errored tile still counts as "loaded" for the frame, so a
            // failing frame can still replace the previous one.
            settleFrame(map, state, overlayPropsRef.current);
            // A failure in the hidden preload frame is not something the user
            // is looking at; it will be reported if that frame is shown.
            if (e.sourceId !== state.want && e.sourceId !== state.active) {
              return;
            }
            // Overlay tile failures (e.g. a single raster tile that can't be
            // decoded) are non-fatal — MapLibre keeps the rest of the layer, so we
            // never blank it. Fire the notice once and log at most once per layer
            // selection so a burst of ~10 per-tile errors doesn't spam the console.
            setOverlayError(true);
            if (!overlayErrorLoggedRef.current) {
              overlayErrorLoggedRef.current = true;
              console.warn(
                "[weather-map] weather overlay tile failed to load (non-fatal)",
                e?.error,
              );
            }
          } else {
            setBaseMapError(true);
            console.error("[weather-map] base map failed to load", e?.error);
          }
        });
      },
    );

    return () => {
      cancelled = true;
      markerRef.current?.remove();
      bubbleMarkersRef.current.forEach((m) => m.remove());
      bubbleMarkersRef.current = [];
      mapRef.current?.remove();
      mapRef.current = null;
      markerRef.current = null;
      restoreRef.current = null;
      styleReadyRef.current = false;
      framesRef.current = newFrameState();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount-only — style + layer switches handled below

  // Switch style when theme changes. The diffed setStyle drops our sources and
  // fires "style.load" again, where restore() re-adds the marker and overlays.
  // styleReadyRef stays true: a diff with nothing to change fires no
  // "style.load", and the overlays are then still in place.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setStyle(getMapTilerStyle(isDark), {
      transformStyle: (_previous, next) => withoutStyleAttributions(next),
    });
  }, [isDark]);

  // Switch the weather overlay frame when the layer or forecast time changes.
  // Before the style is ready there is nothing to do: restore() reads the
  // latest props from refs on "style.load".
  useEffect(() => {
    setOverlayError(false);
    overlayErrorLoggedRef.current = false;
  }, [weatherLayer, weatherTimestamp]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;
    try {
      // Reads the same props through overlayPropsRef.
      syncFramesFrom(map, framesRef.current, overlayPropsRef.current);
    } catch {
      // The style is being replaced (a non-diff setStyle); restore() applies
      // the latest props on its "style.load".
      return;
    }
    // Show the new frame after a short wait even if some tiles are slow, so
    // the radar never lags the timeline label for long.
    const id = window.setTimeout(() => {
      if (mapRef.current !== map) return;
      settleFrame(map, framesRef.current, overlayPropsRef.current, true);
    }, FRAME_SWAP_TIMEOUT_MS);
    return () => window.clearTimeout(id);
  }, [weatherLayer, weatherTimestamp, weatherPrefetchTimestamp]);

  // Draw AQI bubbles when the set changes.
  useEffect(() => {
    const map = mapRef.current;
    const MarkerCtor = markerCtorRef.current;
    if (!map || !MarkerCtor) return;
    const draw = () => {
      bubbleMarkersRef.current.forEach((m) => m.remove());
      bubbleMarkersRef.current = aqiBubbles
        ? renderAqiBubbles(map, MarkerCtor, aqiBubbles)
        : [];
    };
    // Markers do not depend on the style; restore() redraws them anyway.
    draw();
  }, [aqiBubbles]);

  // Switch the AQI overlay when the grid changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    // Before "style.load", restore() applies the latest grid from its ref.
    if (!styleReadyRef.current) return;
    try {
      applyAqiOverlay(map, aqiOverlay);
    } catch {
      // Style being replaced; restore() applies the latest grid.
    }
  }, [aqiOverlay]);

  // Switch the model-field overlay when the field or step changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!map.isStyleLoaded()) {
      const apply = () => applyFieldOverlay(map, fieldOverlay);
      map.once("idle", apply);
      return () => {
        map.off("idle", apply);
      };
    }
    applyFieldOverlay(map, fieldOverlay);
  }, [fieldOverlay]);

  return (
    <div className={cn("relative", className)}>
      {/*
        MapLibre adds .maplibregl-map (position: relative) to the container.
        Its stylesheet is unlayered, so it beats Tailwind 4's layered
        utilities: an `absolute inset-0` on the container itself is overridden
        and the empty div collapses to 0px tall (a blank map). The wrapper
        carries the absolute fill; the container just takes the wrapper's size.
      */}
      <div className="absolute inset-0">
        <div ref={containerRef} className="h-full w-full" />
      </div>
      {baseMapMissingKey && (
        <div
          role="status"
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 bg-surface-base p-6 text-center"
        >
          <p className="text-sm font-semibold text-text-primary">
            Base map unavailable — map key not configured
          </p>
          <p className="max-w-xs text-xs text-text-tertiary">
            Set NEXT_PUBLIC_MAPTILER_API_KEY to enable the interactive weather
            map.
          </p>
        </div>
      )}
      {baseMapError && !baseMapMissingKey && (
        <div
          role="status"
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 bg-surface-base p-6 text-center"
        >
          <p className="text-sm font-semibold text-text-primary">
            Base map unavailable
          </p>
          <p className="max-w-xs text-xs text-text-tertiary">
            The base map could not be loaded. This is usually a temporary issue
            — please try again later.
          </p>
        </div>
      )}
      {overlayError && !baseMapMissingKey && !baseMapError && (
        <div
          role="status"
          className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-[var(--radius-button)] border border-severity-high/30 bg-surface-card/95 px-3 py-1.5 text-xs font-medium text-severity-high shadow-lg backdrop-blur-sm"
        >
          Weather layer unavailable — please try again later
        </div>
      )}
    </div>
  );
}
