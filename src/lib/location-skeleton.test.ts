import { describe, it, expect } from "vitest";
import { skeletonLook } from "./location-skeleton";
import { resolveScene } from "./weather-scenes/resolve-scene";
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
  it("is a neutral partly-cloudy day sky with no hint (first visit)", () => {
    expect(skeletonLook(null)).toEqual({
      sceneType: "partly-cloudy",
      isDay: true,
    });
  });

  it("follows the cached hint with the same scene rule as the backdrop", () => {
    for (const code of [0, 2, 3, 45, 63, 73, 95]) {
      expect(skeletonLook(hint({ weatherCode: code })).sceneType).toBe(
        resolveScene(code, 5),
      );
    }
  });

  it("keeps day and night from the hint", () => {
    expect(skeletonLook(hint({ isDay: false })).isDay).toBe(false);
  });

  it("lets strong wind turn a calm sky windy, like the backdrop", () => {
    expect(
      skeletonLook(hint({ weatherCode: 0, windSpeed: 60 })).sceneType,
    ).toBe("windy");
  });
});
