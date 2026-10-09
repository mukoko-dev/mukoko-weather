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
