import type { ReactNode, Ref } from "react";
import { SKY_CLASS, type SkyFamily, type SkyTexture } from "@/lib/hero";

interface Props {
  /** The sky box, for the live page's reach measurement (WeatherBackdrop). */
  ref?: Ref<HTMLDivElement>;
  family: SkyFamily;
  /** The faint static texture for the family (`skyTexture(family)`). */
  texture: SkyTexture | null;
  /** The optional animated particle layer, painted over the sky
   *  (WeatherBackdrop only; the loading skeleton has none). */
  children?: ReactNode;
}

/**
 * The page sky: one static gradient by condition family x day/night (the
 * `.kestrel` tokens in globals.css, picked by `SKY_CLASS[skyFamily(...)]`),
 * from the very top of the page under the header, fading out at its foot
 * (`.kestrel-reach`). One component for the live backdrop (WeatherBackdrop,
 * which adds the Three.js layer as `children`) and the loading skeleton
 * (LocationSkeleton, no WebGL), so the skeleton and the loaded page paint the
 * SAME sky and it never jumps when the content arrives.
 *
 * Decorative — `aria-hidden`, non-interactive.
 */
export function WeatherSky({ ref, family, texture, children }: Props) {
  return (
    <div
      ref={ref}
      aria-hidden="true"
      // z-0 (not a negative z-index): iOS Safari paints negative-z
      // elements behind the body background when html/body use
      // overflow-x:hidden, making the whole backdrop invisible on iPhone.
      // Explicit stacking instead: backdrop z-0, page content wrapped in
      // z-10 (see WeatherDashboard) — deterministic in every engine.
      className="kestrel-reach pointer-events-none z-0 overflow-hidden"
    >
      {/* The page sky — the static gradient. It is the page background, so it
          runs under the header and the bottom controls. The reduced-motion and
          WebGL-failure fallback, and the base the particle layer paints over. */}
      <div className={`kestrel ${SKY_CLASS[family]}`} />
      {texture === "stars" && <div className="kestrel-stars" />}
      {texture === "streaks" && <div className="kestrel-streaks" />}
      {children}
    </div>
  );
}
