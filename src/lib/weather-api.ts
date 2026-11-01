/**
 * Where the app reaches the Rust weather backend: the Cloudflare Workers in
 * `workers/`, public at `weather-api.mukoko.com`.
 *
 * Vercel is frontend only. Every route the Worker serves is called there and
 * nowhere else: there is no fallback to the frozen Python under `api/py`
 * (owner decision). A call retries once on a network error or a 5xx, and
 * every call carries a timeout; what the Worker itself falls back to (the
 * seasonal estimate, `X-Weather-Provider: fallback`) is the only degraded
 * answer a page shows.
 *
 * The production origin is the default, so nothing has to be configured for
 * the app to work; `NEXT_PUBLIC_WEATHER_API_URL` overrides it (staging
 * Worker, local `wrangler dev`).
 *
 * Edge-safe: reads only `process.env`.
 */

type Env = Record<string, string | undefined>;

/** The production Worker. */
export const DEFAULT_WEATHER_API_URL = "https://weather-api.mukoko.com";

/**
 * The Worker's origin: `NEXT_PUBLIC_WEATHER_API_URL` when it is a bare
 * `https` origin (plain `http` for localhost), else the production default.
 * A typo can never send lookups to a plaintext or credentialed URL.
 */
export function weatherApiBase(env: Env = process.env): string {
  const raw = env.NEXT_PUBLIC_WEATHER_API_URL?.trim();
  if (!raw) return DEFAULT_WEATHER_API_URL;
  try {
    const url = new URL(raw);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
      return DEFAULT_WEATHER_API_URL;
    }
    if (url.username || url.password || url.search || url.hash) {
      return DEFAULT_WEATHER_API_URL;
    }
    return url.origin;
  } catch {
    return DEFAULT_WEATHER_API_URL;
  }
}

/** Every `/v1/{route}` the app calls on the Worker. */
export type WorkerRoute =
  | "weather"
  | "air-quality"
  | "search"
  | "geo"
  | "locations"
  | "history"
  | "locations/profile"
  | "agriculture"
  | "metar"
  | "airports/nearest"
  | "air-quality/grid"
  | "enso"
  | "sg-air"
  | "haze"
  | "normals"
  | "normals/monthly"
  | "aviation/nearest-metar"
  | "suitability"
  | "ai/chat"
  | "ai/history/analyze"
  | "ai/explore/search"
  | "devices"
  | `devices/${string}`;

/** The Worker's URL for a route and its query string (no leading `?`). */
export function workerUrl(
  route: WorkerRoute,
  query: string,
  env: Env = process.env,
): string {
  return `${weatherApiBase(env)}/v1/${route}${query ? `?${query}` : ""}`;
}

/** Default per-attempt ceiling for a browser call to the Worker. */
export const WORKER_TIMEOUT_MS = 8_000;

/**
 * GET a Worker route. One retry on a network error, a timeout or a 5xx
 * (idempotent reads); a 4xx is the answer and is returned as is. A caller's
 * own abort is never retried.
 */
export async function fetchWorker(
  route: WorkerRoute,
  query: string,
  init: RequestInit = {},
  {
    env = process.env,
    fetcher = fetch,
    timeoutMs = WORKER_TIMEOUT_MS,
    retries = 1,
  }: {
    env?: Env;
    fetcher?: typeof fetch;
    timeoutMs?: number;
    retries?: number;
  } = {},
): Promise<Response> {
  const url = workerUrl(route, query, env);
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (init.signal?.aborted) throw lastError ?? init.signal.reason;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeout])
      : timeout;
    try {
      const res = await fetcher(url, { ...init, signal });
      if (res.status < 500 || attempt === retries) return res;
      await res.body?.cancel().catch(() => undefined);
      lastError = new Error(`worker ${res.status}`);
    } catch (err) {
      if (init.signal?.aborted) throw err;
      lastError = err;
      if (attempt === retries) throw err;
    }
  }
  throw lastError;
}

/**
 * A model call is slower than a read (the search makes up to three rounds),
 * so the AI routes get a longer ceiling.
 */
export const WORKER_AI_TIMEOUT_MS = 40_000;

/**
 * POST JSON to a Worker route (the AI routes). Never retried: a model call
 * costs, and an hourly budget counts every attempt.
 */
export function postWorker(
  route: WorkerRoute,
  body: unknown,
  {
    env = process.env,
    fetcher = fetch,
    timeoutMs = WORKER_AI_TIMEOUT_MS,
    signal,
  }: {
    env?: Env;
    fetcher?: typeof fetch;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<Response> {
  return fetchWorker(
    route,
    "",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    },
    { env, fetcher, timeoutMs, retries: 0 },
  );
}

/**
 * The sentence a failed Worker answer carries: the Workers' envelope
 * (`error_description`, else `error`), else the status.
 */
export async function workerErrorMessage(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  const field = (key: string): string | null => {
    const value =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>)[key]
        : null;
    return typeof value === "string" && value ? value : null;
  };
  return (
    field("error_description") ??
    field("error") ??
    `Request failed (${res.status})`
  );
}

/** A places call (`search`, `geo`, `locations`) on the Worker. */
export function fetchPlaces(
  resource: "search" | "geo" | "locations",
  query: string,
  init: RequestInit = {},
  env: Env = process.env,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  return fetchWorker(resource, query, init, { env, fetcher });
}
