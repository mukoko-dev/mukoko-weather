import { roundCoord } from "@/lib/location-privacy";
import type { WeatherData } from "./weather";
import { fetchWeather } from "./weather";
import { fetchWorker } from "./weather-api";

/** How long the home page waits on our own weather API before falling back. */
export const HOME_WEATHER_TIMEOUT_MS = 8000;

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HOME_WEATHER_TIMEOUT_MS);
  try {
    const res = await fetchWorker(
      "weather",
      `lat=${roundCoord(lat)}&lon=${roundCoord(lon)}`,
      { signal: controller.signal },
    );
    if (res.ok) {
      const data: unknown = await res.json();
      if (isRenderableWeather(data)) {
        return {
          weather: data,
          usingFallback: res.headers.get("X-Weather-Provider") === "fallback",
        };
      }
    }
  } catch {
    // Unreachable / timed out — fall through to the direct provider.
  } finally {
    clearTimeout(timer);
  }
  return { weather: await fetchWeather(lat, lon), usingFallback: false };
}

/** How long the dashboard waits on the model-baseline / comparison fetch. */
export const MODEL_WEATHER_TIMEOUT_MS = 10_000;

/**
 * Forecast for a user-selected model plus the comparison series (issue #246).
 *
 * Goes through the Rust Worker (`GET /v1/weather`) with `?models=`
 * (comparison series) and `?model=` (the `selectedForecastModel` preference;
 * `best_match` means the Africa-weighted blend). The Worker does not serve a
 * single-model baseline yet, so a picked model comes back as the blend and
 * `baseline` stays null. Only when the Worker is unreachable does it fall back
 * to a direct Open-Meteo call, which still yields comparison series.
 *
 * `baseline` is set only when a specific model was picked AND our API served
 * it, so the caller can swap the dashboard onto that model.
 */
export async function fetchModelWeather(
  lat: number,
  lon: number,
  model: string,
  models: string[],
): Promise<{ data: WeatherData; baseline: WeatherData | null }> {
  const params = new URLSearchParams({
    lat: String(roundCoord(lat)),
    lon: String(roundCoord(lon)),
    models: models.filter((m) => m && m !== "best_match").join(","),
  });
  if (model && model !== "best_match") params.set("model", model);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_WEATHER_TIMEOUT_MS);
  try {
    const res = await fetchWorker("weather", params.toString(), {
      signal: controller.signal,
    });
    if (res.ok) {
      const data: unknown = await res.json();
      if (isRenderableWeather(data)) {
        const provider = res.headers.get("X-Weather-Provider") ?? "";
        const servedModel = provider === `open-meteo:${model}`;
        return { data, baseline: servedModel ? data : null };
      }
    }
  } catch {
    // Unreachable / timed out — fall through to the direct provider.
  } finally {
    clearTimeout(timer);
  }
  return { data: await fetchWeather(lat, lon, models), baseline: null };
}
