/**
 * When the location dashboard fires its client-side fetches.
 *
 * The server render already carries the full forecast. Anything fetched
 * after mount competes with hydration and the first paint, so a fetch for
 * content below the fold waits until that content is near the viewport.
 */

import type { MinutelyData, ModelForecast, WeatherData } from "@/lib/weather";

/**
 * How close (px) the end of the main column must be before the comparison
 * series + minutely nowcast are fetched. Generous, so the data is in by the
 * time the reader arrives.
 */
export const MODEL_EXTRAS_ROOT_MARGIN = "1200px";

/**
 * Whether to fetch /v1/weather?models=… now.
 *
 * - A picked forecast model (anything but the default blend) becomes the
 *   baseline for the whole page, so it is fetched at once.
 * - With the default blend the response only feeds the nowcast and the
 *   model comparison at the end of the main column: wait until it is near.
 */
export function shouldFetchModelExtras(
  model: string,
  endOfColumnNear: boolean,
): boolean {
  if (model && model !== "best_match") return true;
  return endOfColumnNear;
}

/** Longest wait (ms) for an idle moment before the extras fetch starts. */
export const MODEL_EXTRAS_IDLE_TIMEOUT_MS = 2500;

/** What one /v1/weather?models=… response contributes to the page. */
export interface ModelExtras {
  /** The place + model this was fetched for (modelExtrasKey). */
  key: string;
  /** The picked model's forecast, or null for the default blend. */
  baseline: WeatherData | null;
  minutely: MinutelyData | null;
  series: ModelForecast[];
  time: string[];
}

/** Identity of a fetch: the place (rounded as the API rounds) + the model. */
export function modelExtrasKey(
  lat: number,
  lon: number,
  model: string,
): string {
  return `${lat.toFixed(2)},${lon.toFixed(2)}:${model || "best_match"}`;
}

/** Nothing loaded yet for `key`: the seed is the baseline, no extras. */
export function emptyModelExtras(key: string): ModelExtras {
  return { key, baseline: null, minutely: null, series: [], time: [] };
}

/** Package a response for the place + model it was fetched for. */
export function modelExtrasFromResponse(
  key: string,
  data: Pick<WeatherData, "minutely" | "models" | "models_time">,
  baseline: WeatherData | null,
): ModelExtras {
  return {
    key,
    baseline,
    minutely: data.minutely ?? null,
    series: data.models ?? [],
    time: data.models_time ?? [],
  };
}

/**
 * The extras to render for the place + model on screen: the loaded ones
 * when they belong to it, otherwise nothing. This is what makes a switch
 * back to the blend drop the old model's baseline (and with it its frost
 * banner and "not the fallback" state), nowcast and series immediately.
 */
export function selectModelExtras(
  loaded: ModelExtras,
  key: string,
): ModelExtras {
  return loaded.key === key ? loaded : emptyModelExtras(key);
}
