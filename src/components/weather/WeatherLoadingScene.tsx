"use client";

import { useRef, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  createWeatherScene,
  resolveScene,
  getCachedWeatherHint,
  skyClassName,
} from "@/lib/weather-scenes";
import type {
  CachedWeatherHint,
  WeatherSceneConfig,
  WeatherSceneType,
} from "@/lib/weather-scenes";

interface Props {
  /** Location slug — used to look up cached weather hint for scene selection */
  slug?: string;
  /** Override the status text shown during loading */
  statusText?: string;
  /** Optional action rendered below the loading dots (e.g., fallback city link) */
  action?: React.ReactNode;
}

/** Known app routes that are NOT location slugs — prevents misinterpreting
 *  /explore, /shamwari, etc. as weather locations when extracting from pathname. */
const KNOWN_ROUTES = new Set([
  "explore",
  "locations",
  "shamwari",
  "history",
  "aviation",
  "about",
  "help",
  "privacy",
  "terms",
  "status",
  "embed",
  "display",
]);

/**
 * Branded weather loading animation.
 *
 * Shows a full-screen loading overlay with the mukoko weather logo and
 * animated dots on ALL devices. Three.js particle scene is rendered
 * behind the text, with the animation matching the cached weather
 * conditions for the loading location.
 *
 * First visit to a location shows a default partly-cloudy scene.
 * Subsequent visits show the last-known weather condition (cached 2h).
 *
 * The sky behind it is the real-weather gradient for that scene
 * (`skyClassName`, same palette as the Three.js layer) — static, so it also
 * shows under prefers-reduced-motion. The text sits on a surface panel so it
 * keeps WCAG contrast over every sky.
 *
 * Respects prefers-reduced-motion — skips 3D entirely.
 * Error boundaries ensure a Three.js failure never crashes the loading screen.
 */
export function WeatherLoadingScene({ slug, statusText, action }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Client-only media query detection via useState + useEffect.
  // Both default to false (matching SSR output), then set to the real value
  // on mount. The extra re-render is negligible for a short-lived loading screen.
  // Deferred via rAF to satisfy the lint rule against synchronous setState in effects.
  const [use3D, setUse3D] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  // Cached weather hint for this location (localStorage) — read on mount.
  const [hint, setHint] = useState<CachedWeatherHint | null>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      try {
        setUse3D(
          !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        );
        setIsMobile(
          window.matchMedia("(hover: none), (pointer: coarse)").matches,
        );
      } catch {
        // matchMedia not available — keep defaults (false)
      }
    });
    return () => cancelAnimationFrame(id);
  }, []);

  // Extract slug from URL path as fallback if not passed as prop.
  // Guard against known app routes — only use pathname-derived slug when it
  // looks like a location slug (not a known non-location route like /explore).
  const pathname = usePathname();
  const pathnameSlug = pathname
    ? pathname.split("/").filter(Boolean)[0]
    : undefined;
  const resolvedSlug =
    slug ??
    (pathnameSlug && !KNOWN_ROUTES.has(pathnameSlug)
      ? pathnameSlug
      : undefined);

  // Format slug for display: "bulawayo" → "Bulawayo"
  const locationDisplay = resolvedSlug
    ? resolvedSlug
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ")
    : null;

  // Read the cached hint after mount (localStorage is client-only), deferred
  // via rAF like the media queries above.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      setHint(resolvedSlug ? getCachedWeatherHint(resolvedSlug) : null);
    });
    return () => cancelAnimationFrame(id);
  }, [resolvedSlug]);

  // First visit (no hint) defaults to a partly-cloudy day.
  const sceneType: WeatherSceneType = hint
    ? resolveScene(hint.weatherCode, hint.windSpeed)
    : "partly-cloudy";
  const sceneIsDay = hint?.isDay ?? true;

  useEffect(() => {
    if (!use3D) return;

    const el = containerRef.current;
    if (!el) return;

    let disposed = false;
    let sceneCleanup: (() => void) | null = null;

    const config: WeatherSceneConfig = {
      type: sceneType,
      isDay: sceneIsDay,
      isMobile,
      temperature: hint?.temperature,
      windSpeed: hint?.windSpeed,
    };

    createWeatherScene(el, config)
      .then((result) => {
        if (disposed) {
          result.dispose();
        } else {
          sceneCleanup = result.dispose;
        }
      })
      .catch(() => {
        // Three.js failed to load — text-only fallback is already showing
      });

    return () => {
      disposed = true;
      sceneCleanup?.();
    };
  }, [use3D, isMobile, sceneType, sceneIsDay, hint]);

  // Determine status message
  const displayText =
    statusText ??
    (locationDisplay
      ? `Loading ${locationDisplay} weather...`
      : "Preparing your forecast");

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-background">
      {/* Real-weather sky for the cached condition — static, always shown. */}
      <div
        className={`absolute inset-0 opacity-80 ${skyClassName(sceneType, sceneIsDay)}`}
        aria-hidden="true"
      />
      {use3D && (
        <div
          ref={containerRef}
          className="absolute inset-0 dark:opacity-60"
          aria-hidden="true"
        />
      )}

      <div
        className="relative z-10 mx-4 flex flex-col items-center gap-6 rounded-[var(--radius-card)] bg-surface-card/85 px-6 py-8 text-center shadow-sm"
        role="status"
      >
        <h2 className="font-heading text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl md:text-6xl">
          <span className="text-primary">mukoko</span>{" "}
          <span className="text-text-secondary">weather</span>
        </h2>
        <p className="text-lg font-medium text-text-tertiary sm:text-xl">
          {displayText}
        </p>
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
          <span className="h-2 w-2 animate-pulse rounded-full bg-primary [animation-delay:200ms]" />
          <span className="h-2 w-2 animate-pulse rounded-full bg-primary [animation-delay:400ms]" />
        </div>
        {action && <div className="mt-4">{action}</div>}
        <span className="sr-only">Loading weather data for your location</span>
      </div>
    </div>
  );
}
