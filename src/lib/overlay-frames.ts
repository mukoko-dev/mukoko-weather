/**
 * Weather-overlay frame bookkeeping for the map timeline (#266).
 *
 * Each (layer, timestamp) pair is one "frame": its own MapLibre raster source
 * and layer. Changing the timeline step adds the new frame hidden (opacity 0,
 * which MapLibre still loads) and keeps the old frame on screen until the new
 * one has loaded, then swaps them. The next step can be preloaded the same
 * way, so stepping forward is instant. The previous design swapped the tile
 * URL of a single source with `setTiles`, which blanked the overlay until
 * every new tile arrived.
 *
 * This module is the pure part (ids and the add/remove plan) so it can be
 * tested without a map; MapLibreMap applies the plan.
 */
import { WEATHER_OVERLAY_ID } from "@/lib/map-layers";

/** Paint opacity of the visible overlay frame. */
export const OVERLAY_OPACITY = 0.6;

/** Source and layer id for one frame. */
export function overlayFrameId(layer: string, timestamp: string): string {
  return `${WEATHER_OVERLAY_ID}@${layer}@${timestamp}`;
}

/** The layer part of a frame id, or null for anything else. */
export function overlayFrameLayer(
  id: string | null | undefined,
): string | null {
  if (!id || !id.startsWith(`${WEATHER_OVERLAY_ID}@`)) return null;
  const rest = id.slice(WEATHER_OVERLAY_ID.length + 1);
  const at = rest.indexOf("@");
  return at > 0 ? rest.slice(0, at) : null;
}

export interface FramePlanInput {
  /** Frame ids currently on the map. */
  present: readonly string[];
  /** Frame currently shown at full opacity, if any. */
  active: string | null;
  /** Frame the user asked for, or null to clear the overlay. */
  want: string | null;
  /** Frame to preload hidden, or null. */
  prefetch: string | null;
}

export interface FramePlan {
  /** Frames to add (hidden unless `showWantNow`). */
  add: string[];
  /** Frames to remove from the map. */
  remove: string[];
  /**
   * Show the wanted frame straight away. True when nothing is on screen (the
   * first frame should paint tile by tile, not wait for all of them) or when
   * it is already the visible frame.
   */
  showWantNow: boolean;
}

/**
 * Which frames to add and remove. Keeps the wanted frame, the preload, and
 * the visible frame until the wanted one replaces it; drops everything else,
 * so at most three frames are ever loaded. Switching to another layer drops
 * the visible frame at once: rain must not linger under a temperature legend.
 */
export function planOverlayFrames({
  present,
  active,
  want,
  prefetch,
}: FramePlanInput): FramePlan {
  if (!want) {
    return { add: [], remove: [...present], showWantNow: false };
  }
  const keep = new Set<string>([want]);
  if (prefetch && prefetch !== want) keep.add(prefetch);
  const activePresent =
    active !== null &&
    present.includes(active) &&
    overlayFrameLayer(active) === overlayFrameLayer(want);
  if (activePresent) keep.add(active);

  const remove = present.filter((id) => !keep.has(id));
  const add = [...keep].filter((id) => !present.includes(id));
  return {
    add,
    remove,
    showWantNow: !activePresent || active === want,
  };
}
