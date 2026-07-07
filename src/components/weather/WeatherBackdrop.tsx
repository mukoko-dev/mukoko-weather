"use client";

import { useRef, useEffect, useState } from "react";
import {
  createWeatherScene,
  resolveScene,
  type WeatherSceneConfig,
  type WeatherSceneType,
  type WeatherSceneHandle,
} from "@/lib/weather-scenes";

interface Props {
  /** WMO weather code for the CURRENT conditions (drives the scene). */
  weatherCode: number;
  /** Current wind speed (km/h) — nudges calm scenes to "windy". */
  windSpeed?: number;
  /** Whether it is daytime at the location (Open-Meteo `is_day`). */
  isDay?: boolean;
}

/**
 * Map a resolved scene type (+ day/night) to its static gradient class.
 * Returns a full literal class name — never a constructed one — so Tailwind's
 * JIT keeps them and the "no dynamic class names" rule holds.
 */
function skyClass(type: WeatherSceneType, isDay: boolean): string {
  switch (type) {
    case "clear":
      return isDay ? "weaver-sky-clear-day" : "weaver-sky-clear-night";
    case "partly-cloudy":
      return isDay ? "weaver-sky-clear-day" : "weaver-sky-clear-night";
    case "cloudy":
      return "weaver-sky-cloudy";
    case "rain":
      return "weaver-sky-rain";
    case "thunderstorm":
      return "weaver-sky-thunderstorm";
    case "snow":
      return "weaver-sky-snow";
    case "fog":
      return "weaver-sky-fog";
    case "windy":
      return "weaver-sky-windy";
    default:
      return "";
  }
}

/**
 * Condition-aware animated backdrop for the WHOLE location page — a fixed,
 * full-viewport sky behind all content (Apple Weather style), not confined
 * to the hero card. The sky is strongest at the top (behind the de-carded
 * CurrentConditions hero) and fades into the normal surface background
 * further down so charts and cards keep their usual contrast.
 *
 * Performance discipline (the backdrop stays mounted for the whole page life):
 * - Three.js renderer pixel ratio is capped at 1 (`maxPixelRatio`).
 * - The animation loop is PAUSED when the tab is hidden (`visibilitychange`)
 *   and resumed when it returns — so the GPU idles in background tabs. (No
 *   IntersectionObserver: a fixed, viewport-filling element is always
 *   on-screen while the page is visible.)
 * - Everything is disposed on unmount.
 * - `prefers-reduced-motion` skips Three.js entirely and shows only the static
 *   mineral gradient.
 *
 * Purely decorative — marked `aria-hidden`. A WebGL/import failure degrades to
 * the static gradient (createWeatherScene returns a no-op handle on failure),
 * and the whole card is additionally wrapped in ChartErrorBoundary upstream.
 */
export function WeatherBackdrop({ weatherCode, windSpeed, isDay = true }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Client-only media queries. Default to SSR-safe values, resolve on mount.
  const [animate, setAnimate] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      try {
        setAnimate(!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
        setIsMobile(window.matchMedia("(hover: none), (pointer: coarse)").matches);
      } catch {
        // matchMedia unavailable — keep the static gradient only.
      }
    });
    return () => cancelAnimationFrame(id);
  }, []);

  const sceneType = resolveScene(weatherCode, windSpeed);

  useEffect(() => {
    if (!animate) return;
    const el = containerRef.current;
    if (!el) return;

    let disposed = false;
    let handle: WeatherSceneHandle | null = null;

    const isVisible = () =>
      typeof document === "undefined" || document.visibilityState === "visible";

    // A fixed, viewport-filling backdrop is always on-screen — the only
    // pause signal that matters is tab visibility.
    const syncPlayback = () => {
      if (!handle) return;
      if (isVisible()) handle.resume();
      else handle.pause();
    };

    const handleVisibility = () => syncPlayback();
    document.addEventListener("visibilitychange", handleVisibility);

    const config: WeatherSceneConfig = {
      type: sceneType,
      isDay,
      isMobile,
      windSpeed,
      maxPixelRatio: 1,
    };

    createWeatherScene(el, config)
      .then((result) => {
        if (disposed) {
          result.dispose();
          return;
        }
        handle = result;
        // Apply the current visibility state immediately (may start paused).
        syncPlayback();
      })
      .catch(() => {
        // Static gradient already shows — nothing else to do.
      });

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", handleVisibility);
      handle?.dispose();
    };
  }, [animate, isMobile, isDay, sceneType, windSpeed]);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
    >
      {/* Static mineral gradient — always painted; the reduced-motion fallback. */}
      <div className={`absolute inset-0 weaver-sky ${skyClass(sceneType, isDay)}`} />
      {/* Three.js particle layer (transparent) — only when motion is allowed. */}
      {animate && <div ref={containerRef} className="absolute inset-0" />}
      {/* Readability scrim so hero text keeps contrast over the animation. */}
      <div className="absolute inset-0 weaver-scrim" />
      {/* Fade the sky into the normal surface background further down the
          page so cards, charts and body text keep their usual contrast. */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent from-25% via-surface-base/70 via-65% to-surface-base" />
    </div>
  );
}
