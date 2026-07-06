"use client";

import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreGLMap, Marker } from "maplibre-gl";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { resolveColor } from "@/components/ui/chart";
import {
  WEATHER_OVERLAY_ID,
  buildWeatherOverlaySource,
} from "@/lib/map-layers";

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
  e: { error?: Error; sourceId?: string },
  overlayId: string,
): "overlay" | "base" {
  return e?.sourceId === overlayId ? "overlay" : "base";
}

/**
 * Adds (or replaces) the Tomorrow.io weather overlay on a loaded map.
 * Idempotent — removes any existing overlay first, then re-adds it for the
 * given layer. A null/empty layer just clears the overlay. Safe to call after
 * a style switch (which wipes all sources/layers) to restore the overlay.
 */
function applyWeatherOverlay(map: MapLibreGLMap, layer: string | null) {
  if (map.getLayer(WEATHER_OVERLAY_ID)) map.removeLayer(WEATHER_OVERLAY_ID);
  if (map.getSource(WEATHER_OVERLAY_ID)) map.removeSource(WEATHER_OVERLAY_ID);

  if (!layer) return;

  map.addSource(WEATHER_OVERLAY_ID, buildWeatherOverlaySource(layer));
  map.addLayer({
    id: WEATHER_OVERLAY_ID,
    type: "raster",
    source: WEATHER_OVERLAY_ID,
    paint: { "raster-opacity": 0.6 },
  });
}

interface MapLibreMapProps {
  lat: number;
  lon: number;
  zoom?: number;
  interactive?: boolean;
  weatherLayer?: string | null;
  className?: string;
}

export function MapLibreMap({
  lat,
  lon,
  zoom = 8,
  interactive = true,
  weatherLayer = null,
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

  const isDark =
    theme === "dark" ||
    (theme === "system" &&
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);

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
      ({ Map, Marker: MLMarker, NavigationControl, AttributionControl }) => {
        if (cancelled || !containerRef.current) return;
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

        map.addControl(
          new AttributionControl({
            customAttribution:
              '© <a href="https://www.maptiler.com/">MapTiler</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
          }),
          "bottom-left",
        );

        if (interactive) {
          map.addControl(
            new NavigationControl({ showCompass: false }),
            "top-right",
          );
        }

        const restore = () => {
          markerRef.current?.remove();
          // Resolved here (not at module scope) so each restore — including the
          // post-theme-switch one — picks up the current theme's primary token.
          markerRef.current = new MLMarker({ color: resolveColor("var(--color-primary)") })
            .setLngLat([lon, lat])
            .addTo(map);
          applyWeatherOverlay(map, weatherLayerRef.current);
        };
        restoreRef.current = restore;

        map.on("load", restore);

        // Surface tile/style failures (missing/expired API key → 403/503, rate
        // limit → 429, upstream error) instead of showing a silent blank map.
        // Overlay errors show the transient overlay notice; base-map/style errors
        // show the "Base map unavailable" notice so a blank base map is never
        // silent.
        map.on("error", (e: { error?: Error; sourceId?: string }) => {
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
      const apply = () => applyWeatherOverlay(map, weatherLayer);
      map.once("idle", apply);
      return () => {
        map.off("idle", apply);
      };
    }
    applyWeatherOverlay(map, weatherLayer);
  }, [weatherLayer]);

  return (
    <div className={cn("relative", className)}>
      <div ref={containerRef} className="absolute inset-0" aria-hidden="true" />
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
