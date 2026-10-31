import { describe, it, expect } from "vitest";
import { skeletonLook } from "./location-skeleton";
import { skyFamily, skyTexture } from "./hero";
import type { CachedWeatherHint } from "./weather-scenes/types";

const hint = (over: Partial<CachedWeatherHint> = {}): CachedWeatherHint => ({
  weatherCode: 0,
  isDay: true,
  temperature: 25,
  windSpeed: 5,
  timestamp: 0,
  ...over,
});

describe("skeletonLook", () => {
  it("is a calm overcast-day sky with no hint (first visit)", () => {
    expect(skeletonLook(null)).toEqual({
      family: "cloudy-day",
      texture: null,
    });
  });

  it("follows the cached hint with the hero's own sky mapping", () => {
    for (const code of [0, 2, 3, 45, 63, 73, 95]) {
      for (const isDay of [true, false]) {
        const look = skeletonLook(hint({ weatherCode: code, isDay }));
        expect(look.family).toBe(skyFamily(code, isDay));
        expect(look.texture).toBe(skyTexture(look.family));
      }
    }
  });

  it("carries the night stars and the rain streaks like the page sky", () => {
    expect(skeletonLook(hint({ isDay: false })).texture).toBe("stars");
    expect(skeletonLook(hint({ weatherCode: 63 })).texture).toBe("streaks");
  });
});
