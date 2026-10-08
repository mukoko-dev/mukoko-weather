import type * as THREE from "three";
import type { SkyPhase } from "./palette";

/** Weather scene types matching visual conditions */
export type WeatherSceneType =
  | "clear"
  | "partly-cloudy"
  | "cloudy"
  | "rain"
  | "thunderstorm"
  | "fog"
  | "haze"
  | "snow"
  | "windy";

/** Configuration passed to scene builders */
export interface WeatherSceneConfig {
  type: WeatherSceneType;
  isDay: boolean;
  /**
   * Optional twilight phase (see `skyPhase()` in palette.ts). "dawn"/"dusk"
   * warm the horizon and sun for scenes where the horizon is visible; absent,
   * the scene follows `isDay`.
   */
  phase?: SkyPhase;
  isMobile: boolean;
  temperature?: number;
  windSpeed?: number;
  /**
   * Hard cap on the renderer pixel ratio. Defaults to 1 on mobile and 2 on
   * desktop. Persistent (always-mounted) scenes should pass 1 to keep the GPU
   * cost low regardless of device — the loading overlay leaves it unset.
   */
  maxPixelRatio?: number;
}

/** Returned by each scene builder — drives the animation loop and cleanup */
export interface SceneElements {
  /** Called each frame with elapsed seconds from the Three.js Clock */
  update(elapsed: number): void;
  /** Dispose all geometries, materials, and objects */
  dispose(): void;
}

/**
 * Handle returned by createWeatherScene. `dispose` tears everything down;
 * `pause`/`resume` stop and restart the animation loop without destroying the
 * WebGL context — used to idle a persistent scene when its tab is hidden or it
 * scrolls off-screen.
 */
export interface WeatherSceneHandle {
  dispose(): void;
  pause(): void;
  resume(): void;
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
