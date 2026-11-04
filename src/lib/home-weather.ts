import type { WeatherData } from "./weather";
import { fetchWeather } from "./weather";
import { servedProviderFor } from "./forecast-sources";
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
 * Weather for a GPS-resolved spot on the home page.
 *
 * Goes through the Rust Worker (`GET /v1/weather`) first, the same answer the
 * server render uses, so a GPS swap shows the same numbers as the `/{slug}`
 * page and isn't at the mercy of the browser's own Open-Meteo quota (a 429
 * there used to surface as "Could not detect location"). Only if the Worker
 * is unreachable does it call Open-Meteo directly.
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
      return {
        weather: res.data,
        usingFallback: res.provider === "fallback",
      };
    }
  } catch {
    // Unreachable / timed out — fall through to the direct provider.
  }
  return { weather: await fetchWeather(lat, lon), usingFallback: false };
}

/**
 * Our Worker's forecast for a place the visitor has not asked for yet (the
 * next saved place, got ready in the background): one attempt through the
 * shared read, and NEVER a direct call to the provider. A background request
 * must not spend the visitor's own Open-Meteo allowance, go round the Worker's
 * budgets or use the free, non-commercial host; when the Worker cannot answer,
 * the place is simply not warmed and the visitor's own switch asks as usual.
 * Throws when the Worker does not give a renderable forecast.
 */
export async function fetchWorkerWeatherOnce(
  lat: number,
  lon: number,
): Promise<{ weather: WeatherData; usingFallback: boolean }> {
  const res = await workerData.read<unknown>(
    "weather",
    { lat, lon },
    { retries: 0, signal: AbortSignal.timeout(HOME_WEATHER_TIMEOUT_MS) },
  );
  if (res.ok && isRenderableWeather(res.data)) {
    return { weather: res.data, usingFallback: res.provider === "fallback" };
  }
  throw new Error("the Worker has no forecast for this place");
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
  // `open-meteo:<model>` for an Open-Meteo model, the provider's own name for
  // one it does not serve (Apple Weather).
  const servedModel = (res.provider ?? "") === servedProviderFor(model);
  return {
    ok: true,
    data: res.data,
    baseline: servedModel ? res.data : null,
    fallback: res.provider === "fallback",
  };
}
