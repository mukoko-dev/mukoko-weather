/**
 * Pure choices for the location loading skeleton.
 *
 * The skeleton must look like the first paint of the real page, so it uses
 * the SAME input the page uses for its sky: the sky family
 * (`skyFamily(weatherCode, isDay)`, the hero's one mapping) from the last
 * weather hint this device cached for the place. With no hint (a first visit)
 * it paints a calm overcast-day sky. The hero itself is bars on that sky.
 *
 * Free of React so it is unit-tested in Node.
 */

import { skyFamily, skyTexture, type SkyFamily, type SkyTexture } from "./hero";
import type { CachedWeatherHint } from "./weather-scenes/types";

export interface SkeletonLook {
  /** The page sky family (`SKY_CLASS[family]` picks the `.kestrel` gradient). */
  family: SkyFamily;
  /** The faint static texture that family carries (stars, rain streaks). */
  texture: SkyTexture | null;
}

/** WMO "overcast": a calm grey-blue sky that is rarely badly wrong. */
const NEUTRAL_CODE = 3;

/** The look for a cached hint, or the neutral look when there is none. */
export function skeletonLook(hint: CachedWeatherHint | null): SkeletonLook {
  const family = hint
    ? skyFamily(hint.weatherCode, hint.isDay)
    : skyFamily(NEUTRAL_CODE, true);
  return { family, texture: skyTexture(family) };
}
