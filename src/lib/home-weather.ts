import type { WeatherData } from "./weather";
import { fetchWeather } from "./weather";
import { roundCoord } from "./location-privacy";
import {
  classifyTransportError,
  workerData,
  type WorkerFailure,
} from "./worker-data";

/** How long the home page waits on our own weather API before falling back. */
export const HOME_WEATHER_TIMEOUT_MS = 8000;

/** How long the dashboard waits on the model-baseline / comparison fetch. */
export const MODEL_WEATHER_TIMEOUT_MS = 10_000;

/** Minimal shape check — enough for WeatherDashboard to render safely. */
export function isRenderableWeather(data: unknown): data is WeatherData {
  if (!data || typeof data !== "object") return false;
  const d = data as Partial<WeatherData>;
  return (
    !!d.current &&
    typeof d.current.temperature_2m === "number" &&
    !!d.hourly &&
    Array.isArray(d.hourly.time) &&
    !!d.daily &&
    Array.isArray(d.daily.time)
  );
}

/**
 * How long the visitor's own request to Open-Meteo may take once the Worker
 * has only the seasonal estimate. Shorter than the library default so the
 * two attempts together stay near the place stage's "still trying" clock.
 */
export const DIRECT_FORECAST_TIMEOUT_MS = 6000;

/**
 * Open-Meteo asked straight from the visitor's browser: their own address and
 * their own allowance. Null when it cannot answer either (never throws).
 */
async function fetchDirect(
  lat: number,
  lon: number,
): Promise<{ weather: WeatherData; usingFallback: false } | null> {
  try {
    const weather = await fetchWeather(
      roundCoord(lat),
      roundCoord(lon),
      undefined,
      DIRECT_FORECAST_TIMEOUT_MS,
    );
    return isRenderableWeather(weather)
      ? { weather, usingFallback: false }
      : null;
  } catch {
    return null;
  }
}

/**
 * Weather for a GPS-resolved spot on the home page.
 *
 * Goes through the Rust Worker (`GET /v1/weather`) first, the same answer the
 * server render uses, so a GPS swap shows the same numbers as the `/{slug}`
 * page and isn't at the mercy of the browser's own Open-Meteo quota (a 429
 * there used to surface as "Could not detect location"). Open-Meteo is called
 * directly in two cases: the Worker is unreachable, or it answered with the
 * seasonal estimate. The second is the Workers' shared egress being refused
 * (HTTP 429, the free API's limit): a point that is not already in the Worker's
 * cache then has no forecast, so a place stayed on a days-old copy kept on the
 * device with "the forecast service is slow". The visitor's own browser has
 * its own address and allowance, so it asks before settling for the estimate,
 * and falls back to the Worker's estimate only if that fails too.
 */
export async function fetchHomeWeather(
  lat: number,
  lon: number,
): Promise<{ weather: WeatherData; usingFallback: boolean }> {
  try {
    // Through the shared read: a place already fetched this session (a swipe
    // back, a remount) or being fetched right now costs no second call. The
    // timeout below only bounds how long THIS caller waits: the shared request
    // keeps its own per-attempt limit and carries on, so its answer is kept for
    // the next caller. If the wait runs out the caller falls through to the
    // direct provider, as it did before the shared read.
    const res = await workerData.read<unknown>(
      "weather",
      { lat, lon },
      { retries: 1, signal: AbortSignal.timeout(HOME_WEATHER_TIMEOUT_MS) },
    );
    if (res.ok && isRenderableWeather(res.data)) {
      if (res.provider !== "fallback") {
        return { weather: res.data, usingFallback: false };
      }
      // The Worker had only the seasonal estimate: try the real forecast from
      // here before showing it. The estimate stands if that fails too.
      return (
        (await fetchDirect(lat, lon)) ?? {
          weather: res.data,
          usingFallback: true,
        }
      );
    }
  } catch {
    // Unreachable / timed out — fall through to the direct provider.
  }
  return { weather: await fetchWeather(lat, lon), usingFallback: false };
}

/** What `loadModelWeather` hands the dashboard: the forecast, or why not. */
export type ModelWeatherResult =
  | {
      ok: true;
      data: WeatherData;
      /** Set only when a specific model was picked AND our API served it. */
      baseline: WeatherData | null;
      /** The Worker answered with the seasonal estimate (no live provider). */
      fallback: boolean;
    }
  | { ok: false; failure: WorkerFailure };

/**
 * Forecast for a user-selected model plus the comparison series (issue #246),
 * and the live forecast a page that was served the seasonal estimate swaps in
 * (#414).
 *
 * Goes through the Rust Worker (`GET /v1/weather`) with `?models=`
 * (comparison series) and `?model=` (the `selectedForecastModel` preference;
 * `best_match` means the Africa-weighted blend). The Worker serves a picked
 * model as the baseline (`X-Weather-Provider: open-meteo:<model>`, its own
 * cache row, `best_match` filling the variables the model does not publish);
 * with no data for that model at the point it answers `best_match` and
 * `baseline` stays null.
 *
 * It never swallows a failure: the typed reason comes back (`rate_limited`,
 * `timeout`, `server`, `offline`, `invalid`) so the caller can retry sensibly
 * and tell the visitor. `force` reads past a remembered failure (a retry).
 */
export async function loadModelWeather(
  lat: number,
  lon: number,
  model: string,
  models: string[],
  { force = false }: { force?: boolean } = {},
): Promise<ModelWeatherResult> {
  let res;
  try {
    res = await workerData.read<unknown>(
      "weather",
      {
        lat,
        lon,
        models: models.filter((m) => m && m !== "best_match").join(","),
        model: model && model !== "best_match" ? model : undefined,
      },
      {
        force,
        // The live-fetch controller (live-fetch.ts) owns retrying, with a
        // backoff that honours Retry-After; a second hidden call per attempt
        // would only add to the load on a Worker that is struggling.
        retries: 0,
        signal: AbortSignal.timeout(MODEL_WEATHER_TIMEOUT_MS),
      },
    );
  } catch (err) {
    // Our own wait ran out (the request itself carries on for the next caller).
    return { ok: false, failure: classifyTransportError(err) };
  }
  if (!res.ok) {
    return {
      ok: false,
      failure: res.failure ?? { kind: "server", status: res.status },
    };
  }
  if (!isRenderableWeather(res.data)) {
    return { ok: false, failure: { kind: "invalid", status: res.status } };
  }
  const servedModel = (res.provider ?? "") === `open-meteo:${model}`;
  return {
    ok: true,
    data: res.data,
    baseline: servedModel ? res.data : null,
    fallback: res.provider === "fallback",
  };
}
