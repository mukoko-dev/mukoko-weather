"use client";

import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreGLMap, Marker } from "maplibre-gl";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { WEATHER_OVERLAY_ID, buildWeatherOverlaySource } from "@/lib/map-layers";

const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_API_KEY ?? "";

export function getMapTilerStyle(isDark: boolean): string {
  const style = isDark ? "streets-v2-dark" : "streets-v2";
  return `https://api.maptiler.com/maps/${style}/style.json?key=${MAPTILER_KEY}`;
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
  const theme = useAppStore((s) => s.theme);

  const isDark =
    theme === "dark" ||
    (theme === "system" &&
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);

  useEffect(() => {
    if (!containerRef.current) return;

    let map: MapLibreGLMap;

    import("maplibre-gl").then(({ Map, Marker: MLMarker, NavigationControl }) => {
      import("maplibre-gl/dist/maplibre-gl.css");

      map = new Map({
        container: containerRef.current!,
        style: getMapTilerStyle(isDark),
        center: [lon, lat],
        zoom,
        interactive,
        attributionControl: {
          customAttribution: '© <a href="https://www.maptiler.com/">MapTiler</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        },
      });

      mapRef.current = map;

      if (interactive) {
        map.addControl(new NavigationControl({ showCompass: false }), "top-right");
      }

      const restore = () => {
        markerRef.current?.remove();
        markerRef.current = new MLMarker({ color: "#0047AB" })
          .setLngLat([lon, lat])
          .addTo(map);
        applyWeatherOverlay(map, weatherLayerRef.current);
      };
      restoreRef.current = restore;

      map.on("load", restore);

      // Surface tile failures (missing/expired API key → 503, rate limit → 429,
      // upstream error) instead of showing a silent blank overlay.
      map.on("error", (e: { error?: Error; sourceId?: string }) => {
        if (e?.sourceId === WEATHER_OVERLAY_ID) {
          setOverlayError(true);
          // eslint-disable-next-line no-console
          console.error("[weather-map] overlay tile failed to load", e?.error);
        }
      });
    });

    return () => {
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

  // Switch weather overlay when the selected layer changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    setOverlayError(false);
    applyWeatherOverlay(map, weatherLayer);
  }, [weatherLayer]);

  return (
    <div className={cn("relative", className)}>
      <div ref={containerRef} className="absolute inset-0" aria-hidden="true" />
      {overlayError && (
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
