/**
 * Where the app reaches the Rust weather backend (the Cloudflare Workers in
 * `workers/`, public at `weather-api.mukoko.com`).
 *
 * Vercel is frontend only: the backend is moving to the Workers (#148), and
 * the Python under `api/py` is frozen. New backend behaviour (bare-name
 * resolve, unnamed points, regions in search) exists only there, so it is
 * behind this switch: with `NEXT_PUBLIC_WEATHER_API_URL` unset the app behaves
 * exactly as before and keeps using `/api/py` (see {@link placesUrl}); set it
 * once the Worker is verified and the app calls the Worker first.
 *
 * Edge-safe: reads only `process.env`.
 */

type Env = Record<string, string | undefined>;

/**
 * The Worker's origin, or null when the switch is off. Only an `https`
 * origin (plain `http` for localhost) is accepted, so a typo can never send
 * place lookups to a plaintext or credentialed URL.
 */
export function weatherApiBase(env: Env = process.env): string | null {
  const raw = env.NEXT_PUBLIC_WEATHER_API_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
      return null;
    }
    if (url.username || url.password || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The Worker's `/v1/{resource}` URL for a places call (`search`, `geo`,
 * `locations`), or null while the switch is off. */
export function workerPlacesUrl(
  resource: "search" | "geo" | "locations",
  query: string,
  env: Env = process.env,
): string | null {
  const base = weatherApiBase(env);
  return base ? `${base}/v1/${resource}?${query}` : null;
}

/** The frozen Python route for the same call (the fallback). */
export function legacyPlacesUrl(
  resource: "search" | "geo" | "locations",
  query: string,
  base = "",
): string {
  return `${base}/api/py/${resource}?${query}`;
}

/**
 * Fetch a places resource from the Worker when the switch is on, falling back
 * to `/api/py` when the Worker is off, unreachable or answers a server error
 * (never on a 4xx: that is the answer). `init` applies to both calls.
 */
export async function fetchPlaces(
  resource: "search" | "geo" | "locations",
  query: string,
  init: RequestInit = {},
  env: Env = process.env,
  fetcher: typeof fetch = fetch,
  /** Origin for the `/api/py` fallback; empty in the browser, the site's
   * own origin when called from a server component. */
  legacyBase = "",
): Promise<Response> {
  const worker = workerPlacesUrl(resource, query, env);
  if (worker) {
    try {
      const res = await fetcher(worker, init);
      if (res.status < 500) return res;
    } catch (err) {
      if (init.signal?.aborted) throw err;
    }
  }
  return fetcher(legacyPlacesUrl(resource, query, legacyBase), init);
}

/** The public Worker origin, used when `NEXT_PUBLIC_WEATHER_API_URL` is unset. */
export const DEFAULT_WORKER_ORIGIN = "https://weather-api.mukoko.com";

/**
 * Where a Worker-only route is called: the configured origin, else the public
 * Worker. There is no `/api/py` fallback for these routes (the Python backend
 * is being removed, #333), so there is no off switch either.
 */
export function workerOrigin(env: Env = process.env): string {
  return weatherApiBase(env) ?? DEFAULT_WORKER_ORIGIN;
}

/** `{origin}/v1/{path}` for a Worker-only route. */
export function workerUrl(path: string, env: Env = process.env): string {
  return `${workerOrigin(env)}/v1/${path.replace(/^\/+/, "")}`;
}
