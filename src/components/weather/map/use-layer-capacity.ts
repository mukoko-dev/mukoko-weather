"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  busySubject,
  capacityNoteText,
  capacityState,
  fallbackLayerLabel,
  isTomorrowLayer,
  layerCapacity,
  type CapacityProbe,
  type CapacityState,
  type RecheckResult,
} from "@/lib/map-capacity";

export interface LayerCapacity extends CapacityState {
  /** The fallback is on screen and a request is out for a new answer. */
  rechecking: boolean;
  /**
   * "Try again" was answered from memory (a real request is not allowed yet):
   * the button says it just looked, for as long as the wait lasts.
   */
  recent: boolean;
  /**
   * "Try again": one real request (never more often than the probe's floor).
   * Resolves with what it learned; never rejects.
   */
  recheck: () => Promise<RecheckResult>;
}

/**
 * Whether the layer the person asked for will draw, and what to show if not.
 *
 * Any layer that is not a Tomorrow.io one (satellite, air quality, wildfire,
 * model fields) is never checked and costs nothing. For a Tomorrow.io layer the
 * probe is looked at when the layer or place changes (`probe.check`): a verdict
 * younger than a minute answers at once and sends nothing, and the same verdict
 * serves all four layers. The verdict lives in the probe (a store), not in this
 * hook, so a remount, StrictMode's second effect or a second map share it and
 * ask once.
 *
 * Nothing asks again on a timer. "Try again" (`recheck`) is the only forced
 * ask, and it is forced by the call itself, not by remembered state: the
 * automatic look after a layer change never forces.
 *
 * `announce` is the page's polite live region (`useMziziHarness`): it is told
 * when the layer is swapped, when it is back, and what a "Try again" found.
 * `restoreFocus` is called when the note goes away while focus was on it (the
 * button was removed with it), so focus is not dropped on the page.
 */
export function useLayerCapacity({
  layer,
  lat,
  lon,
  mapZoom,
  probe = layerCapacity,
  announce,
  restoreFocus,
}: {
  layer: string;
  lat: number;
  lon: number;
  mapZoom: number;
  probe?: CapacityProbe;
  announce?: (message: string) => void;
  restoreFocus?: () => void;
}): LayerCapacity {
  const view = useSyncExternalStore(
    probe.subscribe,
    probe.getSnapshot,
    probe.getServerSnapshot,
  );
  const probing = isTomorrowLayer(layer);

  // The automatic look: when the layer or place changes (and on mount). It
  // never forces, and a fresh verdict answers without a request.
  useEffect(() => {
    if (!probing) return;
    void probe.check({ layer, lat, lon, mapZoom });
  }, [probing, probe, layer, lat, lon, mapZoom]);

  const state = capacityState(layer, view);

  // "Try again" answered from memory: the button says so until a real request
  // is allowed again.
  const [recent, setRecent] = useState(false);
  const recentTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(recentTimer.current), []);

  const recheck = useCallback(async () => {
    const result = await probe.recheck({ layer, lat, lon, mapZoom });
    if (!result.asked && result.retryAfterMs > 0) {
      setRecent(true);
      clearTimeout(recentTimer.current);
      recentTimer.current = setTimeout(
        () => setRecent(false),
        result.retryAfterMs,
      );
      announce?.("Checked a moment ago.");
    } else if (result.verdict === "busy") {
      announce?.(`${busySubject(layer)} is still busy.`);
    }
    return result;
  }, [probe, layer, lat, lon, mapZoom, announce]);

  // Said once for each change, not on every render: the swap to the fallback
  // (also when the layer asked for changes while it stays busy), and the layer
  // coming back. Choosing a keyless layer by hand is not "coming back".
  const wasBusy = useRef(false);
  useEffect(() => {
    if (state.busy) {
      announce?.(capacityNoteText(layer, fallbackLayerLabel()));
    } else if (wasBusy.current && probing) {
      announce?.(`${busySubject(layer)} is back.`);
      // The note and its button are gone; if focus was on them it is now on
      // the page itself.
      if (
        typeof document !== "undefined" &&
        (!document.activeElement || document.activeElement === document.body)
      )
        restoreFocus?.();
    }
    wasBusy.current = state.busy;
  }, [state.busy, layer, probing, announce, restoreFocus]);

  return {
    ...state,
    rechecking: state.busy && state.checking,
    recent,
    recheck,
  };
}
