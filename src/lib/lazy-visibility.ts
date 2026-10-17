/**
 * Pure decision helpers for LazySection's bidirectional visibility.
 *
 * Kept out of the component so the rules that decide when a section is
 * unmounted — and how much space it keeps while unmounted — can be unit
 * tested without a DOM or IntersectionObserver.
 */

/**
 * Whether an element currently has a layout box. `display: none` elements
 * (and their descendants) return no client rects.
 */
export function hasLayoutBox(el: Element): boolean {
  return el.getClientRects().length > 0;
}

/**
 * Decide whether a mounted lazy section should be unmounted.
 *
 * Unmount only when the section is genuinely far off-screen: NOT intersecting
 * the extended unload margin AND it still has a layout box.
 *
 * An element with no layout box (`display: none`) never intersects anything,
 * so IntersectionObserver reports it as "not intersecting" wherever it sits on
 * the page. That is not "far away". The `.herd` stack hides a lazy wrapper
 * whose card rendered nothing, and treating that as off-screen caused an
 * endless loop: unmount, the skeleton reappears (it is not hidden), the load
 * observer remounts, the card renders nothing again, the wrapper is hidden
 * again. The visible result was the skeleton blinking several times a second
 * and everything below it jumping. A box-less section also holds nothing
 * worth reclaiming, so keeping it mounted costs nothing.
 */
export function shouldUnloadSection(entry: {
  isIntersecting: boolean;
  hasLayoutBox: boolean;
}): boolean {
  return !entry.isIntersecting && entry.hasLayoutBox;
}

/**
 * The height (px) to reserve for a section while it is unmounted, from its
 * measured height at the moment of unmounting. Returns null when there is
 * nothing to reserve (zero, negative or non-finite).
 *
 * Reserving the height means swapping a tall card for its shorter skeleton
 * does not shift everything below it, so scroll anchoring does not nudge the
 * page while the reader is looking at something else.
 */
export function reservedHeightPx(measured: number): number | null {
  if (!Number.isFinite(measured) || measured <= 0) return null;
  return Math.ceil(measured);
}

// ── Mount scheduling ────────────────────────────────────────────────────────
//
// How far ahead a section starts loading, how many sections may mount at
// once, and how long the queue waits between mounts. The v0.10.0 values
// (100 px ahead on phones, one mount at a time, 150 ms apart) meant a reader
// scrolling at a normal pace overtook the queue and saw a run of skeletons.
// Sections now start loading 1.5 viewports ahead, capable devices mount two
// at a time, and the settle gap is a frame or two. Low-end devices (≤ 2 GB
// RAM, ≤ 2 cores, or Save-Data on) keep the old one-at-a-time protection.

/** What LazySection reads from the browser to pick its schedule. */
export interface DeviceHints {
  viewportWidth: number;
  viewportHeight: number;
  /** navigator.hardwareConcurrency (undefined when the browser hides it). */
  hardwareConcurrency?: number;
  /** navigator.deviceMemory in GB (Chromium only). */
  deviceMemory?: number;
  /** navigator.connection.saveData. */
  saveData?: boolean;
}

/** Below this width a viewport counts as a phone (matches Tailwind `md`). */
export const MOBILE_MAX_WIDTH = 768;
/** The unload margin never drops below this (px). */
export const MIN_UNLOAD_MARGIN_PX = 1500;

/** True for devices that should keep the conservative schedule. */
export function isConstrainedDevice(h: DeviceHints): boolean {
  if (h.saveData) return true;
  if (typeof h.deviceMemory === "number" && h.deviceMemory <= 2) return true;
  if (typeof h.hardwareConcurrency === "number" && h.hardwareConcurrency <= 2)
    return true;
  return false;
}

/**
 * How far below the viewport (px) a section starts loading: 1.5 viewport
 * heights on capable devices (1 on constrained ones), at least 400 px and
 * at most 1600 px.
 */
export function loadMarginPx(h: DeviceHints): number {
  const factor = isConstrainedDevice(h) ? 1 : 1.5;
  const height = Number.isFinite(h.viewportHeight) ? h.viewportHeight : 800;
  return Math.round(Math.min(1600, Math.max(400, height * factor)));
}

/**
 * How far off-screen (px) a mounted section must be before it is unmounted.
 * Always at least twice the load margin, so a section that has just loaded
 * at the edge of the load margin is never immediately judged "far away"
 * (which would loop mount → unmount → mount).
 */
export function unloadMarginPx(loadMargin: number): number {
  return Math.max(MIN_UNLOAD_MARGIN_PX, Math.round(loadMargin * 2));
}

/** How many sections may be mounting at the same time. */
export function maxConcurrentMounts(h: DeviceHints): number {
  return isConstrainedDevice(h) ? 1 : 2;
}

/** Pause (ms) after a mount's first paint before the next one starts. */
export function settleDelayMs(h: DeviceHints): number {
  if (isConstrainedDevice(h)) return 120;
  return h.viewportWidth < MOBILE_MAX_WIDTH ? 32 : 16;
}

/** Read the device hints from the browser (safe defaults on the server). */
export function readDeviceHints(): DeviceHints {
  if (typeof window === "undefined") {
    return { viewportWidth: 1024, viewportHeight: 800 };
  }
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { saveData?: boolean };
  };
  return {
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory,
    saveData: nav.connection?.saveData === true,
  };
}
