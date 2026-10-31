"use client";

import { useRef, useEffect, useState } from "react";
import {
  createWeatherScene,
  resolveScene,
  skyPhase,
  type WeatherSceneConfig,
  type WeatherSceneHandle,
} from "@/lib/weather-scenes";
import {
  readBackdropHints,
  SCROLL_IDLE_MS,
  shouldAnimateBackdrop,
  shouldRunBackdrop,
} from "@/lib/weather-scenes/backdrop-policy";
import { WeatherSky } from "@/components/weather/WeatherSky";

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
 * - The animation loop is PAUSED when the tab is hidden (`visibilitychange`),
 *   while the reader is scrolling, and once the page is scrolled more than a
 *   viewport down (the hero is gone and cards cover the sky), and resumed
 *   when none of those hold (shouldRunBackdrop). (No IntersectionObserver: a
 *   fixed, viewport-filling element is always "on-screen".)
 * - Everything is disposed on unmount, and the WebGL context is released.
 * - `prefers-reduced-motion`, Save-Data or ≤ 2 GB RAM skip
 *   Three.js entirely and show only the static sky gradient
 *   (shouldAnimateBackdrop).
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
        // prefers-reduced-motion: reduce, Save-Data and low-end devices
        // keep the static sky (see backdrop-policy.ts).
        setAnimate(shouldAnimateBackdrop(readBackdropHints()));
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

    // Run only while the tab is visible, the reader is not scrolling and
    // the sky region is still on screen (shouldRunBackdrop).
    let scrolling = false;
    let scrollTimer: number | undefined;
    const syncPlayback = () => {
      if (!handle) return;
      const run = shouldRunBackdrop({
        tabVisible: isVisible(),
        scrolling,
        scrollY: window.scrollY,
        viewportHeight: window.innerHeight,
      });
      if (run) handle.resume();
      else handle.pause();
    };

    const handleVisibility = () => syncPlayback();
    const handleScroll = () => {
      if (!scrolling) {
        scrolling = true;
        syncPlayback();
      }
      window.clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(() => {
        scrolling = false;
        syncPlayback();
      }, SCROLL_IDLE_MS);
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("scroll", handleScroll, { passive: true });

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
      window.removeEventListener("scroll", handleScroll);
      window.clearTimeout(scrollTimer);
      handle?.dispose();
    };
  }, [animate, isMobile, isDay, phase, sceneType, windSpeed]);

  return (
    <WeatherSky type={sceneType} isDay={isDay} phase={phase}>
      {/* Three.js particle layer (transparent) — only when motion is allowed. */}
      {animate && (
        <div
          ref={containerRef}
          className="absolute inset-0 opacity-75 dark:opacity-40"
        />
      )}
    </WeatherSky>
  );
}
