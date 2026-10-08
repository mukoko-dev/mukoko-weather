"use client";

import { useRef, useEffect, useState } from "react";
import {
  createWeatherScene,
  resolveScene,
  skyClassName,
  skyPhase,
  type WeatherSceneConfig,
  type WeatherSceneHandle,
} from "@/lib/weather-scenes";

interface Props {
  /** WMO weather code for the CURRENT conditions (drives the scene). */
  weatherCode: number;
  /** Current wind speed (km/h) — nudges calm scenes to "windy". */
  windSpeed?: number;
  /** Whether it is daytime at the location (Open-Meteo `is_day`). */
  isDay?: boolean;
  /**
   * Optional location-local clock + today's sunrise/sunset (ISO-8601, the
   * same timezone — Open-Meteo `current.time`, `daily.sunrise[0]`,
   * `daily.sunset[0]`). When all are given, the 40 min around sunrise/sunset
   * paints a warm dawn/dusk horizon; otherwise the sky follows `isDay`.
   */
  currentTime?: string;
  sunrise?: string;
  sunset?: string;
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
 *   sky gradient.
 *
 * Colour: every sky, cloud, particle and light colour is the real colour of
 * that weather at that time of day (src/lib/weather-scenes/palette.ts). The
 * static `.hornbill-sky-*` gradient under the canvas is built from the SAME
 * palette (mirrored as --weather-sky-* tokens in globals.css), so the
 * reduced-motion / WebGL-failure fallback is the same sky as the animation.
 *
 * Subdued on purpose (sky at opacity-80, particles at opacity-75 — 40 in
 * dark theme, matching the dimmed dark-theme sky tokens): the location
 * hero is a solid sky plate (see CurrentConditions / `.kori`), and the page
 * sky is texture behind it, never the hero itself.
 *
 * Purely decorative — marked `aria-hidden`. A WebGL/import failure degrades to
 * the static gradient (createWeatherScene returns a no-op handle on failure),
 * and the whole card is additionally wrapped in ChartErrorBoundary upstream.
 */
export function WeatherBackdrop({
  weatherCode,
  windSpeed,
  isDay = true,
  currentTime,
  sunrise,
  sunset,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Client-only media queries. Default to SSR-safe values, resolve on mount.
  const [animate, setAnimate] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      try {
        setAnimate(
          !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        );
        setIsMobile(
          window.matchMedia("(hover: none), (pointer: coarse)").matches,
        );
      } catch {
        // matchMedia unavailable — keep the static gradient only.
      }
    });
    return () => cancelAnimationFrame(id);
  }, []);

  const sceneType = resolveScene(weatherCode, windSpeed);
  const phase = skyPhase(isDay, currentTime, sunrise, sunset);

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
      phase,
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
  }, [animate, isMobile, isDay, phase, sceneType, windSpeed]);

  return (
    <div
      aria-hidden="true"
      // z-0 (not a negative z-index): iOS Safari paints fixed negative-z
      // elements behind the body background when html/body use
      // overflow-x:hidden, making the whole backdrop invisible on iPhone.
      // Explicit stacking instead: backdrop z-0, page content wrapped in
      // z-10 (see WeatherDashboard) — deterministic in every engine.
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
    >
      {/* Static real-weather sky gradient — always painted; the reduced-motion
          and WebGL-failure fallback, same palette as the animation. */}
      <div
        className={`absolute inset-0 opacity-80 ${skyClassName(sceneType, isDay, phase)}`}
      />
      {/* Three.js particle layer (transparent) — only when motion is allowed. */}
      {animate && (
        <div
          ref={containerRef}
          className="absolute inset-0 opacity-75 dark:opacity-40"
        />
      )}
      {/* Readability veil behind the header + breadcrumb text that sits
          directly on the sky (WCAG 4.5:1 for text-tertiary on every sky). */}
      <div className="absolute inset-0 hornbill-veil" />
      {/* Fade the sky into the normal surface background further down the
          page so cards, charts and body text keep their usual contrast. */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent from-25% via-surface-base/70 via-65% to-surface-base" />
    </div>
  );
}
