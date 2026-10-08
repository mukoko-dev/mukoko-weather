"use client";

import { useEffect, useRef, useState } from "react";
import type {
  Map as MapLibreGLMap,
  Marker,
  RasterTileSource,
  ExpressionSpecification,
} from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import { useAppStore } from "@/lib/store";
import { resolveTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { resolveColor } from "@/components/ui/chart";
import {
  maplibreWorkerUrl,
  WEATHER_OVERLAY_ID,
  AQI_OVERLAY_ID,
  buildWeatherOverlaySource,
} from "@/lib/map-layers";
import {
  AQI_BANDS,
  AQI_BAND_BG_CLASS,
  AQI_BAND_LABELS,
  AQI_BAND_SEVERITY_TOKEN,
  type AqBubble,
} from "@/lib/aq-grid";

const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_API_KEY ?? "";

export function getMapTilerStyle(isDark: boolean): string {
  const style = isDark ? "streets-v2-dark" : "streets-v2";
  return `https://api.maptiler.com/maps/${style}/style.json?key=${MAPTILER_KEY}`;
}

/**
 * Classifies a MapLibre `error` event as either a weather-overlay failure or a
 * base-map failure (style/base-tile/source load error). The weather overlay is
 * the only source we register under `overlayId`, so any error not tied to it —
 * including a failed style.json fetch (expired/over-quota MapTiler key → 403/429)
 * which carries no `sourceId` — is treated as a base-map failure. Exported for
 * testing.
 */
export function classifyMapError(
  e: { error?: unknown; sourceId?: string },
  overlayId: string,
): "overlay" | "base" {
  return e?.sourceId === overlayId ? "overlay" : "base";
}

/**
 * Adds (or updates) the Tomorrow.io weather overlay on a loaded map. When the
 * overlay already exists, only its tile URL changes (`setTiles`), so a layer or
 * timeline change swaps tiles without tearing the layer down. A null layer
 * clears the overlay. A style switch wipes all sources, so the restore path
 * takes the add branch. `timestamp` defaults to the current tiles ("now").
 */
function applyWeatherOverlay(
  map: MapLibreGLMap,
  layer: string | null,
  timestamp: string = "now",
) {
  if (!layer) {
    if (map.getLayer(WEATHER_OVERLAY_ID)) map.removeLayer(WEATHER_OVERLAY_ID);
    if (map.getSource(WEATHER_OVERLAY_ID)) map.removeSource(WEATHER_OVERLAY_ID);
    return;
  }

  const spec = buildWeatherOverlaySource(layer, timestamp);
  const existing = map.getSource(WEATHER_OVERLAY_ID) as
    | RasterTileSource
    | undefined;
  if (existing && map.getLayer(WEATHER_OVERLAY_ID)) {
    existing.setTiles(spec.tiles);
    return;
  }

  if (map.getLayer(WEATHER_OVERLAY_ID)) map.removeLayer(WEATHER_OVERLAY_ID);
  if (map.getSource(WEATHER_OVERLAY_ID)) map.removeSource(WEATHER_OVERLAY_ID);
  map.addSource(WEATHER_OVERLAY_ID, spec);
  map.addLayer({
    id: WEATHER_OVERLAY_ID,
    type: "raster",
    source: WEATHER_OVERLAY_ID,
    paint: { "raster-opacity": 0.6 },
  });
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

  map.addSource(AQI_OVERLAY_ID, { type: "geojson", data });
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
  className?: string;
}

export function MapLibreMap({
  lat,
  lon,
  zoom = 8,
  interactive = true,
  weatherLayer = null,
  weatherTimestamp = "now",
  aqiBubbles = null,
  navigationControl = true,
  attributionControl = true,
  aqiOverlay = null,
  className = "h-full w-full",
}: MapLibreMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreGLMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  // Restores the marker + weather overlay after a style switch wipes them.
  // Set inside the mount effect (needs the async-imported Marker constructor).
  const restoreRef = useRef<(() => void) | null>(null);
  // Keep the latest layer in a ref so async callbacks (map "load", post-setStyle
  // restore) always apply the current selection.
  const weatherLayerRef = useRef<string | null>(weatherLayer);
  weatherLayerRef.current = weatherLayer;
  const weatherTimestampRef = useRef<string>(weatherTimestamp);
  weatherTimestampRef.current = weatherTimestamp;
  // AQI bubbles: markers are created with the Marker constructor, which is only
  // available after the async import, so it is held in a ref from mount.
  const bubbleMarkersRef = useRef<Marker[]>([]);
  const markerCtorRef = useRef<typeof Marker | null>(null);
  const aqiBubblesRef = useRef<readonly AqBubble[] | null>(aqiBubbles);
  aqiBubblesRef.current = aqiBubbles;
  // Same pattern for the AQI overlay: restore() reads the latest collection.
  const aqiOverlayRef = useRef<FeatureCollection | null>(aqiOverlay);
  aqiOverlayRef.current = aqiOverlay;
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
          style: getMapTilerStyle(isDark),
          center: [lon, lat],
          zoom,
          interactive,
          // The default attribution control sits bottom-right, which would collide
          // with the bottom-right overlay layer switcher. Disable it here and re-add
          // it explicitly at bottom-left below.
          attributionControl: false,
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
            new AttributionControl({
              customAttribution:
                '© <a href="https://www.maptiler.com/">MapTiler</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
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
          applyWeatherOverlay(
            map,
            weatherLayerRef.current,
            weatherTimestampRef.current,
          );
          applyAqiOverlay(map, aqiOverlayRef.current);
          bubbleMarkersRef.current.forEach((m) => m.remove());
          bubbleMarkersRef.current = aqiBubblesRef.current
            ? renderAqiBubbles(map, MLMarker, aqiBubblesRef.current)
            : [];
        };
        restoreRef.current = restore;

        map.on("load", restore);

        // Surface tile/style failures (missing/expired API key → 403/503, rate
        // limit → 429, upstream error) instead of showing a silent blank map.
        // Overlay errors show the transient overlay notice; base-map/style errors
        // show the "Base map unavailable" notice so a blank base map is never
        // silent.
        map.on("error", (e: { error?: unknown; sourceId?: string }) => {
          if (classifyMapError(e, WEATHER_OVERLAY_ID) === "overlay") {
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount-only — style + layer switches handled below

  // Switch style when theme changes. setStyle wipes all sources/layers/markers,
  // so restore the marker + overlay once the new style settles (single-shot).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setStyle(getMapTilerStyle(isDark));
    map.once("idle", () => restoreRef.current?.());
  }, [isDark]);

  // Switch weather overlay when the selected layer changes. If the style isn't
  // loaded yet (e.g. user toggles a layer before the base style finishes), defer
  // until the map goes idle and apply then — otherwise the switch silently no-ops.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    setOverlayError(false);
    overlayErrorLoggedRef.current = false;
    if (!map.isStyleLoaded()) {
      const apply = () =>
        applyWeatherOverlay(map, weatherLayer, weatherTimestamp);
      map.once("idle", apply);
      return () => {
        map.off("idle", apply);
      };
    }
    applyWeatherOverlay(map, weatherLayer, weatherTimestamp);
  }, [weatherLayer, weatherTimestamp]);

  // Draw AQI bubbles when the set changes. Like the fill overlay, defer to the
  // next idle while the style is still loading.
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
    if (!map.isStyleLoaded()) {
      map.once("idle", draw);
      return () => {
        map.off("idle", draw);
      };
    }
    draw();
  }, [aqiBubbles]);

  // Switch the AQI overlay when the grid changes. Mirrors the weather-layer
  // effect: defer to the next idle if the style is still loading.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!map.isStyleLoaded()) {
      const apply = () => applyAqiOverlay(map, aqiOverlay);
      map.once("idle", apply);
      return () => {
        map.off("idle", apply);
      };
    }
    applyAqiOverlay(map, aqiOverlay);
  }, [aqiOverlay]);

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
