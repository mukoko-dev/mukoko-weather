/**
 * The Rust backend's URL for a `/v1/...` route (the Cloudflare Workers behind
 * `weather-api.mukoko.com`). The browser and the server call the Worker
 * directly: there is no `/api/py` fallback for the routes listed in
 * `workers/README.md`.
 *
 * `NEXT_PUBLIC_WEATHER_API_URL` overrides the origin (a preview or local
 * Worker); unset, it is the production Worker.
 *
 * Edge-safe: reads only `process.env`.
 */
import { weatherApiBase } from "@/lib/weather-api";

/** The production Worker origin. */
export const WORKER_ORIGIN = "https://weather-api.mukoko.com";

/** `https://weather-api.mukoko.com/v1/activities?mode=categories` for
 * `workerUrl("/v1/activities?mode=categories")`. */
export function workerUrl(
  pathAndQuery: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return `${weatherApiBase(env) ?? WORKER_ORIGIN}${pathAndQuery}`;
}
