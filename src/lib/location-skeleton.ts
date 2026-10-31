/**
 * Pure choices for the location loading skeleton.
 *
 * The skeleton must look like the first paint of the real page, so it uses
 * the SAME input the page uses for its sky: the scene type (`resolveScene`,
 * as WeatherBackdrop does) from the last weather hint this device cached for
 * the place. With no hint (a first visit) it paints a partly-cloudy-day sky.
 * The hero itself is bars on that sky: no solid plate colour to get wrong.
 *
 * Free of React so it is unit-tested in Node.
 */

import { resolveScene } from "./weather-scenes/resolve-scene";
import type {
  CachedWeatherHint,
  WeatherSceneType,
} from "./weather-scenes/types";

export interface SkeletonLook {
  /** Sky scene for the static backdrop gradient. */
  sceneType: WeatherSceneType;
  isDay: boolean;
}

/** The look for a cached hint, or the neutral look when there is none. */
export function skeletonLook(hint: CachedWeatherHint | null): SkeletonLook {
  if (!hint) return { sceneType: "partly-cloudy", isDay: true };
  return {
    sceneType: resolveScene(hint.weatherCode, hint.windSpeed),
    isDay: hint.isDay,
  };
}
