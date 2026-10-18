/**
 * When the page-wide WeatherBackdrop runs its Three.js layer, and when it
 * idles. Pure functions so the rules are unit tested without WebGL.
 *
 * The look on capable devices is unchanged: same scene, same pixel ratio
 * cap (1). What changes is who pays for it:
 * - Reduced motion, Save-Data or ≤ 2 GB RAM (where the browser reports it)
 *   get the static sky gradient (the same palette, built from tokens) and no
 *   WebGL context. CPU core count is not used: WebKit capped
 *   navigator.hardwareConcurrency at 2 on iPhones and Firefox's
 *   resistFingerprinting reports 2, so it misreads capable devices.
 * - The loop idles while the reader is scrolling and while the sky region is
 *   scrolled away (the cards cover the backdrop further down the page), so
 *   the GPU is not competing with scrolling on mid-range phones.
 */

export interface BackdropDeviceHints {
  reducedMotion: boolean;
  saveData?: boolean;
  /** navigator.deviceMemory in GB (Chromium only). */
  deviceMemory?: number;
}

/** Whether to create the Three.js layer at all. */
export function shouldAnimateBackdrop(h: BackdropDeviceHints): boolean {
  if (h.reducedMotion) return false;
  if (h.saveData) return false;
  if (typeof h.deviceMemory === "number" && h.deviceMemory <= 2) return false;
  return true;
}

/**
 * How far down the page (in viewport heights) the animated sky is still
 * worth rendering. Below this the hero has scrolled away and the sky is a
 * thin band behind cards; the last frame stays painted.
 */
export const SKY_VISIBLE_VIEWPORTS = 1;

/** How long after the last scroll event the loop resumes (ms). */
export const SCROLL_IDLE_MS = 180;

/** Whether the loop should run for this scroll position and tab state. */
export function shouldRunBackdrop(state: {
  tabVisible: boolean;
  scrolling: boolean;
  scrollY: number;
  viewportHeight: number;
}): boolean {
  if (!state.tabVisible) return false;
  if (state.scrolling) return false;
  const limit =
    (Number.isFinite(state.viewportHeight) ? state.viewportHeight : 800) *
    SKY_VISIBLE_VIEWPORTS;
  return state.scrollY <= limit;
}

/** Read the device hints for shouldAnimateBackdrop from the browser. */
export function readBackdropHints(): BackdropDeviceHints {
  if (typeof window === "undefined") return { reducedMotion: true };
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { saveData?: boolean };
  };
  let reducedMotion = true;
  try {
    reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
  } catch {
    // matchMedia unavailable — stay on the static sky.
  }
  return {
    reducedMotion,
    saveData: nav.connection?.saveData === true,
    deviceMemory: nav.deviceMemory,
  };
}
