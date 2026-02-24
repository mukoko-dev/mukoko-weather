import type * as THREE from "three";

/** Weather scene types matching visual conditions */
export type WeatherSceneType =
  | "clear"
  | "partly-cloudy"
  | "cloudy"
  | "rain"
  | "thunderstorm"
  | "fog"
  | "snow"
  | "windy";

/** Configuration passed to scene builders */
export interface WeatherSceneConfig {
  type: WeatherSceneType;
  isDay: boolean;
  isMobile: boolean;
  temperature?: number;
  windSpeed?: number;
}

/** Returned by each scene builder — drives the animation loop and cleanup */
export interface SceneElements {
  /** Called each frame with elapsed seconds from the Three.js Clock */
  update(elapsed: number): void;
  /** Dispose all geometries, materials, and objects */
  dispose(): void;
}

/** Cached weather data stored per location for instant scene selection */
export interface CachedWeatherHint {
  weatherCode: number;
  isDay: boolean;
  temperature: number;
  windSpeed: number;
  timestamp: number;
}

/** Signature for scene builder functions in scenes/*.ts */
export type SceneBuilder = (
  THREE: typeof import("three"),
  scene: THREE.Scene,
  config: WeatherSceneConfig,
) => SceneElements;
