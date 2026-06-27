"use client";

import { useEffect, useRef } from "react";
import type { Map as MapLibreGLMap, Marker } from "maplibre-gl";
import { useAppStore } from "@/lib/store";

const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_API_KEY ?? "";

export function getMapTilerStyle(isDark: boolean): string {
  const style = isDark ? "streets-v2-dark" : "streets-v2";
  return `https://api.maptiler.com/maps/${style}/style.json?key=${MAPTILER_KEY}`;
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
  const theme = useAppStore((s) => s.theme);

  const isDark =
    theme === "dark" ||
    (theme === "system" &&
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);

  useEffect(() => {
    if (!containerRef.current) return;

    let map: MapLibreGLMap;
    let marker: Marker;

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

      map.on("load", () => {
        // Add location marker
        marker = new MLMarker({ color: "#0047AB" })
          .setLngLat([lon, lat])
          .addTo(map);
        markerRef.current = marker;

        // Add Tomorrow.io weather overlay if requested
        if (weatherLayer) {
          map.addSource("weather-overlay", {
            type: "raster",
            tiles: [`/api/py/map-tiles?z={z}&x={x}&y={y}&layer=${weatherLayer}`],
            tileSize: 256,
          });
          map.addLayer({
            id: "weather-overlay",
            type: "raster",
            source: "weather-overlay",
            paint: { "raster-opacity": 0.6 },
          });
        }
      });
    });

    return () => {
      markerRef.current?.remove();
      mapRef.current?.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount-only — style switches handled below

  // Switch style when theme changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setStyle(getMapTilerStyle(isDark));
  }, [isDark]);

  // Switch weather overlay when layer changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    if (map.getLayer("weather-overlay")) map.removeLayer("weather-overlay");
    if (map.getSource("weather-overlay")) map.removeSource("weather-overlay");

    if (weatherLayer) {
      map.addSource("weather-overlay", {
        type: "raster",
        tiles: [`/api/py/map-tiles?z={z}&x={x}&y={y}&layer=${weatherLayer}`],
        tileSize: 256,
      });
      map.addLayer({
        id: "weather-overlay",
        type: "raster",
        source: "weather-overlay",
        paint: { "raster-opacity": 0.6 },
      });
    }
  }, [weatherLayer]);

  return <div ref={containerRef} className={className} aria-hidden="true" />;
}
