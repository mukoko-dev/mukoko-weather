/**
 * Path-form helper for the Worker, kept for existing importers
 * (`workerUrl("/v1/tags")`). The origin logic is `weatherApiBase` in
 * `weather-api.ts`, the canonical module; this file only joins a path onto it.
 *
 * Edge-safe: reads only `process.env`.
 */
import { weatherApiBase, DEFAULT_WEATHER_API_URL } from "@/lib/weather-api";

/** The production Worker origin. */
export const WORKER_ORIGIN = DEFAULT_WEATHER_API_URL;

/** `https://weather-api.mukoko.com/v1/activities?mode=categories` for
 * `workerUrl("/v1/activities?mode=categories")`. */
export function workerUrl(
  pathAndQuery: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return `${weatherApiBase(env)}${pathAndQuery}`;
}
