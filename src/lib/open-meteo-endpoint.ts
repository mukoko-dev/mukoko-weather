/**
 * Where the TypeScript direct-fetch fallback sends its Open-Meteo forecast
 * request. Mirror of `api/py/_open_meteo.py` (forecast half only).
 *
 * Default: the public API. On the SERVER only, `OPEN_METEO_BASE_URL` points
 * the call at our self-hosted Open-Meteo (`infra/open-meteo/`), with the
 * gateway key from `OPEN_METEO_API_KEY` in the `X-Mukoko-OM-Key` header (fixed:
 * the gateway's matcher and log redaction use this exact name). The key is
 * never sent to an `open-meteo.com` host. These are deliberately NOT
 * `NEXT_PUBLIC_*`: the browser never sees the key, so a client-side fallback
 * always uses the public API.
 */

export const PUBLIC_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
export const FORECAST_PATH = "/v1/forecast";
/** Must match `infra/open-meteo/gateway/Caddyfile` and `api/py/_open_meteo.py`. */
export const KEY_HEADER = "X-Mukoko-OM-Key";

const PUBLIC_DOMAIN = "open-meteo.com";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

type Env = Record<string, string | undefined>;

function serverEnv(): Env | null {
  // Browser bundles get no env (and must never send the key).
  if (typeof window !== "undefined") return null;
  return typeof process !== "undefined" ? process.env : null;
}

/** Validated base (origin + optional path prefix) or null → public API. */
export function configuredForecastBase(
  env: Env | null = serverEnv(),
): string | null {
  const raw = env?.OPEN_METEO_BASE_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    return null;
  if (!url.hostname || url.search || url.hash || url.username || url.password)
    return null;
  return raw.replace(/\/+$/, "");
}

/** URL of the forecast endpoint to call. */
export function openMeteoForecastUrl(env: Env | null = serverEnv()): string {
  const base = configuredForecastBase(env);
  if (!base) return PUBLIC_FORECAST_URL;
  return base.endsWith(FORECAST_PATH) ? base : base + FORECAST_PATH;
}

/** True unless `url` points at an Open-Meteo-run host (decided by hostname). */
export function isSelfHosted(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return !(host === PUBLIC_DOMAIN || host.endsWith(`.${PUBLIC_DOMAIN}`));
}

/** Headers for a call to `url`: empty for any Open-Meteo host. */
export function openMeteoHeaders(
  url: string,
  env: Env | null = serverEnv(),
): Record<string, string> {
  if (!isSelfHosted(url)) return {};
  const key = env?.OPEN_METEO_API_KEY?.trim();
  return key ? { [KEY_HEADER]: key } : {};
}
