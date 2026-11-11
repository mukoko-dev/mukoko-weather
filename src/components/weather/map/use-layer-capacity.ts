"use client";

import { useCallback, useEffect, useState } from "react";
import {
  capacityState,
  isTomorrowLayer,
  layerCapacity,
  type CapacityProbe,
  type CapacityVerdict,
} from "@/lib/map-capacity";

export interface LayerCapacity {
  /** The layer to draw: the one asked for, or the default while it is busy. */
  layer: string;
  /** The layer is a Tomorrow.io one and the tiles Worker has no live tile for it. */
  busy: boolean;
  /**
   * The layer is a Tomorrow.io one and the first answer has not come yet: the
   * map holds its overlay back (one tile is being asked for) rather than ask
   * for a dozen that may all be blank.
   */
  held: boolean;
  /** "Try again" was tapped and its answer has not come yet. */
  rechecking: boolean;
  /** Ask the Worker again (at most once every few seconds, see map-capacity.ts). */
  recheck: () => void;
}

/**
 * Whether the layer the person asked for will draw. Any layer that is not a
 * Tomorrow.io one (satellite, air quality, wildfire, model fields) is never
 * checked and costs nothing. For a Tomorrow.io layer it asks `probe` once per
 * layer, place and visit; the probe remembers the answer for a minute.
 *
 * The answer is kept per layer and place, so switching layer or place starts
 * with no verdict (`held`) instead of showing the previous layer's.
 */
export function useLayerCapacity({
  layer,
  lat,
  lon,
  mapZoom,
  probe = layerCapacity,
}: {
  layer: string;
  lat: number;
  lon: number;
  mapZoom: number;
  probe?: CapacityProbe;
}): LayerCapacity {
  const probing = isTomorrowLayer(layer);
  const key = `${layer}|${lat},${lon}`;
  // How many times "Try again" was tapped for this key (0: never).
  const [asked, setAsked] = useState<{ key: string; times: number } | null>(
    null,
  );
  const times = asked?.key === key ? asked.times : 0;
  const [answer, setAnswer] = useState<{
    key: string;
    times: number;
    verdict: CapacityVerdict;
  } | null>(null);

  useEffect(() => {
    if (!probing) return;
    let current = true;
    void probe
      .check({ layer, lat, lon, mapZoom, force: times > 0 })
      .then((verdict) => {
        if (current) setAnswer({ key, times, verdict });
      });
    return () => {
      current = false;
    };
  }, [probing, probe, layer, lat, lon, mapZoom, key, times]);

  const recheck = useCallback(() => {
    setAsked((prev) => ({
      key,
      times: prev?.key === key ? prev.times + 1 : 1,
    }));
  }, [key]);

  const known = answer?.key === key ? answer.verdict : null;
  return {
    ...capacityState(layer, known),
    rechecking: probing && known !== null && answer?.times !== times,
    recheck,
  };
}
