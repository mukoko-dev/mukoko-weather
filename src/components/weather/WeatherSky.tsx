import type { ReactNode } from "react";
import { skyClassName } from "@/lib/weather-scenes/palette";
import type { SkyPhase } from "@/lib/weather-scenes/palette";
import type { WeatherSceneType } from "@/lib/weather-scenes/types";

interface Props {
  type: WeatherSceneType;
  isDay: boolean;
  phase?: SkyPhase;
  /** The optional animated particle layer, painted between the sky and the
   *  readability veil (WeatherBackdrop only; the loading skeleton has none). */
  children?: ReactNode;
}

/**
 * The static page sky: a fixed, full-viewport gradient behind all content,
 * strongest at the top and fading into the normal surface background lower
 * down. One component for the live backdrop (WeatherBackdrop, which adds the
 * Three.js layer as `children`) and the loading skeleton (LocationSkeleton,
 * no WebGL), so the skeleton and the loaded page paint the SAME sky and the
 * background never jumps when the content arrives.
 *
 * Decorative — `aria-hidden`, non-interactive.
 */
export function WeatherSky({ type, isDay, phase, children }: Props) {
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
        className={`absolute inset-0 opacity-80 ${skyClassName(type, isDay, phase)}`}
      />
      {children}
      {/* Readability veil behind the header + breadcrumb text that sits
          directly on the sky (WCAG 4.5:1 for text-tertiary on every sky). */}
      <div className="absolute inset-0 hornbill-veil" />
      {/* Fade the sky into the normal surface background further down the
          page so cards, charts and body text keep their usual contrast. */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent from-25% via-surface-base/70 via-65% to-surface-base" />
    </div>
  );
}
