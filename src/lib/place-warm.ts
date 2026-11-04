import { isConstrainedDevice, type DeviceHints } from "./lazy-visibility";
import { pagerIndex } from "./location-pager";
import type { WarmResult } from "./place-controller";
import { placeTargetOf, type PlaceTarget } from "./place-target";

/**
 * Which places to get ready while the visitor reads the one on screen, so a
 * swipe or a tap on the lane paints from memory instead of waiting for the
 * network. Pure: the hook that runs it (PlaceStage) and the controller that
 * does the fetching (`warm`) are elsewhere.
 *
 * The limits are deliberately small. Every warmed place is one forecast
 * request (a cold point costs the Worker an Open-Meteo call, and the Worker's
 * share of that allowance is shared by every visitor), so only the places a
 * swipe can reach next are warmed, nearest first, and none when the visitor
 * asked for less data.
 */

/** Places warmed around the one on screen on a capable device: two each way. */
export const WARM_PLACES = 4;

/** On a low-memory device: only the next place. */
export const WARM_PLACES_CONSTRAINED = 1;

/**
 * How many places to warm now. None while offline or with Save-Data on (the
 * visitor asked for less data); one on a low-memory device; four otherwise.
 */
export function warmLimit(hints: DeviceHints, online: boolean): number {
  if (!online || hints.saveData) return 0;
  return isConstrainedDevice(hints) ? WARM_PLACES_CONSTRAINED : WARM_PLACES;
}

/**
 * The places to warm, nearest first: the next page, the previous one, the one
 * after next, the one before previous, and so on, at most `limit`. Empty when
 * the page on screen is not one of the pager's pages (a sub-route of a place
 * counts as the place). The page on screen is never in the list, and neither
 * is anything that is not an in-place target (`placeTargetOf`).
 */
export function warmTargets(
  sequence: readonly string[],
  pathname: string | null | undefined,
  limit: number,
): PlaceTarget[] {
  const at = pagerIndex(pathname, sequence);
  if (at < 0 || !(limit > 0)) return [];
  const out: PlaceTarget[] = [];
  const seen = new Set<string>([sequence[at]]);
  for (let step = 1; step < sequence.length && out.length < limit; step++) {
    for (const dir of [1, -1]) {
      if (out.length >= limit) break;
      const href = sequence[at + dir * step];
      if (href === undefined || seen.has(href)) continue;
      seen.add(href);
      const target = placeTargetOf(href);
      if (target) out.push(target);
    }
  }
  return out;
}

/** How a pass over the places ended. */
export type WarmPassEnd = "done" | "stopped" | "failed";

/**
 * After a pass that failed, nothing is warmed for this long: the Worker is
 * refusing the client, or cannot be reached, or the provider behind it is
 * limited and it only had the seasonal estimate. Asking again at every place
 * change would only add to that.
 */
export const WARM_PAUSE_AFTER_FAILURE_MS = 60_000;

/**
 * Warm `targets` in order, one at a time. A hidden tab waits (`untilVisible`)
 * instead of giving up, so coming back to it carries on; an aborted signal
 * stops the pass; a place that FAILED ends it at once (the rest would meet the
 * same refusal) and the caller pauses.
 */
export async function warmPass(
  targets: readonly PlaceTarget[],
  warm: (target: PlaceTarget) => Promise<WarmResult>,
  io: {
    signal: AbortSignal;
    untilVisible: (signal: AbortSignal) => Promise<void>;
  },
): Promise<WarmPassEnd> {
  for (const target of targets) {
    await io.untilVisible(io.signal);
    if (io.signal.aborted) return "stopped";
    if ((await warm(target)) === "failed") return "failed";
  }
  return "done";
}
