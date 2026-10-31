"use client";

import { useRef, useEffect, useState } from "react";
import {
  createWeatherScene,
  resolveScene,
  skyPhase,
  type WeatherSceneConfig,
  type WeatherSceneHandle,
} from "@/lib/weather-scenes";
import { SKY_CLASS, skyFamily, skyTexture } from "@/lib/hero";
import {
  readBackdropHints,
  SCROLL_IDLE_MS,
  shouldAnimateBackdrop,
  shouldRunBackdrop,
} from "@/lib/weather-scenes/backdrop-policy";

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
 * Condition-aware animated backdrop for the location page — the
 * sky at the top of the page, behind the header and the hero (Apple Weather
 * style). It is solid through the first screen (hero + Conditions card),
 * fades out over its last 6rem and scrolls away with the page, so charts,
 * cards and headings further down keep their usual contrast on the ordinary
 * surface.
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
 * Colour: the static gradient is the page sky (`.kestrel-*`, `--sky-*` tokens
 * in globals.css, family from src/lib/hero.ts): the owner's night and rain
 * skies, day skies for light theme, deep dusk for dark. It carries faint
 * static texture (stars at night, diagonal streaks in rain). The Three.js
 * particle layer paints over it (opacity-30, 20 in dark theme) and is the only
 * thing that moves; the reduced-motion / WebGL-failure fallback is the same
 * sky without it.
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
  const family = skyFamily(weatherCode, isDay);
  const texture = skyTexture(family);
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
    <div
      aria-hidden="true"
      // z-0 (not a negative z-index): iOS Safari paints negative-z
      // elements behind the body background when html/body use
      // overflow-x:hidden, making the whole backdrop invisible on iPhone.
      // Explicit stacking instead: backdrop z-0, page content wrapped in
      // z-10 (see WeatherDashboard) — deterministic in every engine.
      className="kestrel-reach pointer-events-none z-0 overflow-hidden"
    >
      {/* The page sky — one static gradient by condition family x day/night
          (src/lib/hero.ts skyFamily, tokens in globals.css). It is the page
          background, so it runs under the header and the bottom controls.
          The reduced-motion and WebGL-failure fallback, and the base the
          particle layer paints over. */}
      <div className={`kestrel ${SKY_CLASS[family]}`} />
      {texture === "stars" && <div className="kestrel-stars" />}
      {texture === "streaks" && <div className="kestrel-streaks" />}
      {/* Three.js particle layer (transparent) — only when motion is allowed. */}
      {animate && (
        <div
          ref={containerRef}
          className="absolute inset-0 opacity-30 dark:opacity-20"
        />
      )}
    </div>
  );
}
