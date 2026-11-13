"use client";

import { useRef, useEffect, useState } from "react";
import {
  createWeatherScene,
  resolveScene,
  skyPhase,
  type WeatherSceneConfig,
  type WeatherSceneHandle,
} from "@/lib/weather-scenes";
import { skyFamily, skyReachCss, skyTexture } from "@/lib/hero";
import { WeatherSky } from "@/components/weather/WeatherSky";
import { createCanvasScene } from "@/lib/weather-scenes/canvas/create-canvas-scene";
import { afterPaintWhenIdle } from "@/lib/weather-scenes/start-gate";
import {
  backdropMode,
  readBackdropHints,
  SCROLL_IDLE_MS,
  shouldRunBackdrop,
  stillTexture,
  type BackdropMode,
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
 * - The animated layer is not loaded until the weather has painted and the
 *   browser is idle (start-gate.ts). The static sky below shows meanwhile, so
 *   nothing moves or shifts when it arrives: the layer is absolutely
 *   positioned inside the sky box, which is already its final size.
 * - Three.js renderer pixel ratio is capped at 1 (`maxPixelRatio`).
 * - The animation loop is PAUSED when the tab is hidden (`visibilitychange`),
 *   while the reader is scrolling, and once the page is scrolled more than a
 *   viewport down (the hero is gone and cards cover the sky), and resumed
 *   when none of those hold (shouldRunBackdrop). (No IntersectionObserver: a
 *   fixed, viewport-filling element is always "on-screen".)
 * - Everything is disposed on unmount, and the WebGL context is released.
 * - `prefers-reduced-motion`, Save-Data or ≤ 2 GB RAM skip
 *   Three.js entirely and show only the static sky gradient
 *   (backdropMode). iPhone and iPad never get WebGL here; unless the person
 *   asked for less motion or less data they get the 2D effects instead
 *   (lib/weather-scenes/canvas): a random, bounded particle effect for every
 *   weather scene on one small canvas, paused by the same tab-hidden, scroll
 *   and scrolled-away rules as the 3D scene.
 *
 * Colour: the static gradient is the page sky (`.kestrel-*`, `--sky-*` tokens
 * in globals.css, family from src/lib/hero.ts): the owner's night and rain
 * skies, day skies for light theme, deep dusk for dark. It carries faint
 * static texture (stars at night, diagonal streaks in rain) for a sky that does
 * not move: the texture goes as soon as a live animated layer draws the same
 * thing, so the rain and the stars are never shown twice (stillTexture). The
 * Three.js particle layer paints over the sky (opacity-30, 20 in dark theme)
 * and is the only thing that moves; the reduced-motion / WebGL-failure fallback
 * is the same sky with its still texture.
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
  const effectsRef = useRef<HTMLDivElement>(null);
  const skyRef = useRef<HTMLDivElement>(null);

  // Extend the sky with its content: it always reaches past the Conditions
  // card (or the hero when the card is not directly under it), so large text,
  // a short landscape viewport or a taller card never push the card into the
  // fade. Re-measured when the page resizes or the card's size changes.
  useEffect(() => {
    const sky = skyRef.current;
    if (!sky || typeof ResizeObserver === "undefined") return;
    let observed: Element | null = null;
    const measure = () => {
      const target =
        document.querySelector("[data-sky-card]") ??
        document.querySelector("[data-sky-hero]");
      if (target !== observed) {
        if (observed) ro.unobserve(observed);
        if (target) ro.observe(target);
        observed = target;
      }
      const bottom = target
        ? target.getBoundingClientRect().bottom + window.scrollY
        : null;
      const rootPx = parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      const css = skyReachCss(bottom, rootPx);
      if (css) sky.style.setProperty("--sky-reach", css);
      else sky.style.removeProperty("--sky-reach");
    };
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [weatherCode, isDay]);

  // Client-only media queries. Default to SSR-safe values, resolve on mount.
  const [mode, setMode] = useState<BackdropMode>("static");
  const animate = mode === "webgl";
  // True once the animated layer is really drawing (see stillTexture).
  const [live, setLive] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    let reduced: MediaQueryList | null = null;
    const update = () => setMode(backdropMode(readBackdropHints()));
    const id = requestAnimationFrame(() => {
      try {
        // prefers-reduced-motion: reduce, Save-Data and low-end devices
        // keep the static sky; iPhone and iPad get the 2D canvas effects
        // (see backdrop-policy.ts).
        update();
        setIsMobile(
          window.matchMedia("(hover: none), (pointer: coarse)").matches,
        );
        // Turning Reduce Motion on or off while the page is open stops or
        // starts the sky without a reload.
        reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
        reduced.addEventListener("change", update);
      } catch {
        // matchMedia unavailable — keep the static gradient only.
      }
    });
    return () => {
      cancelAnimationFrame(id);
      reduced?.removeEventListener("change", update);
    };
  }, []);

  // The animated layer's first start waits for the weather to paint and the
  // browser to idle (start-gate.ts). Armed once for this backdrop, not once per
  // run of the scene effect: a change of scene or phase while it waits cannot
  // push it back, so its upper bound holds. After it opens, a restart (another
  // scene, a new phase) has nothing left to wait for.
  const [startOpen, setStartOpen] = useState(false);
  useEffect(() => {
    if (mode === "static" || startOpen) return;
    return afterPaintWhenIdle(() => setStartOpen(true));
  }, [mode, startOpen]);

  const sceneType = resolveScene(weatherCode, windSpeed);
  const family = skyFamily(weatherCode, isDay);
  const texture = skyTexture(family);
  const phase = skyPhase(isDay, currentTime, sunrise, sunset);

  useEffect(() => {
    if (mode === "static" || !startOpen) return;
    // The 3D scene fills the sky box; the 2D effects fill the bounded hero region.
    const el = (mode === "webgl" ? containerRef : effectsRef).current;
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
      // WebGL fills the whole sky box, so it stays at 1. The 2D effects are one
      // bounded box of plain strokes and soft sprites, which stay crisp on a
      // retina screen at 2 for a small fraction of the cost.
      maxPixelRatio: mode === "webgl" ? 1 : 2,
    };

    const create = mode === "webgl" ? createWeatherScene : createCanvasScene;
    create(el, config)
      .then((result) => {
        if (disposed) {
          result.dispose();
          return;
        }
        handle = result;
        setLive(result.live);
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
      // Nothing is drawing between one scene and the next: the still sky shows.
      setLive(false);
    };
  }, [mode, startOpen, isMobile, isDay, phase, sceneType, windSpeed]);

  return (
    <WeatherSky
      ref={skyRef}
      family={family}
      // The still streaks and stars go once a live layer draws the same thing
      // (stillTexture), so the rain and the stars are never shown twice.
      texture={stillTexture(texture, mode, sceneType, live)}
    >
      {/* Three.js particle layer (transparent) — only when motion is allowed. */}
      {animate && (
        <div
          ref={containerRef}
          className="absolute inset-0 opacity-30 dark:opacity-20"
        />
      )}
      {/* The 2D effects (iPhone and iPad): a bounded box, faded at its foot. */}
      {mode === "canvas" && (
        <div ref={effectsRef} className="kestrel-effects" />
      )}
    </WeatherSky>
  );
}
