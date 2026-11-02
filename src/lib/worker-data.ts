/**
 * One shared, cached read of the Rust Worker for everything a page asks for.
 *
 * Why it exists (#414): a single cold page load from one browser made about
 * 150 Worker calls in two minutes (weather 60, haze 29, air-quality/grid 26,
 * air-quality 23, normals 23, geo 21, aviation 19), and 52 of them were refused
 * by the per-IP limiter. Every section fetched in its own mount effect, and
 * `LazySection` unmounts a section that scrolls far away and mounts it again
 * when it returns, so each scroll or swipe repeated the fetch; two components
 * asked for the same air-quality reading at once; an unmount aborted the
 * request the next mount then had to repeat.
 *
 * The rules, for every Worker read that is not a user action:
 *
 * - A request is keyed by route + the 0.05 degree cell of its coordinate
 *   (`cellKey`, the same grid the Worker's own caches use) + any other
 *   query parameter, so one place and its neighbours cost one call.
 * - Callers of the same key share ONE in-flight request. Never more than one
 *   in flight per key.
 * - A good answer is kept in memory for a per-route time (a few minutes for
 *   conditions, longer for climate normals), so a remount, a swipe back to a
 *   place already shown or a second component asking for the same thing costs
 *   nothing. It is never kept forever: after the time it is read again.
 * - A failure is remembered briefly (20 s; 60 s for a 429), so a failing or
 *   rate-limited Worker is not asked again on every remount.
 * - A caller leaving (unmount, route change) stops WAITING; it never cancels
 *   the shared request, because the next caller will want the answer.
 * - Coordinates are sent rounded to 3 decimals (`roundCoord`, the app's
 *   privacy rule), except where the caller asks for the exact value (the GPS
 *   fix sent to `/v1/geo`).
 *
 * The memory is the page's: a full document reload starts empty. Keeping the
 * app mounted across navigations is the app shell's job (#414, PR 2).
 *
 * Browser and server safe; the transport and the clock are injectable.
 */

import { roundCoord } from "./location-privacy";
import { cellKey } from "./cell-key";
import { fetchWorker, type WorkerRoute } from "./weather-api";

/** How long a good answer is kept, by route (ms). Anything else: DEFAULT. */
export const WORKER_DATA_TTL_MS: Readonly<Record<string, number>> = {
  weather: 5 * 60_000,
  "air-quality": 10 * 60_000,
  "air-quality/grid": 10 * 60_000,
  haze: 10 * 60_000,
  // The normal high for a calendar day: the date is part of the key.
  normals: 60 * 60_000,
  "normals/monthly": 6 * 60 * 60_000,
  history: 10 * 60_000,
  "aviation/nearest-metar": 5 * 60_000,
  metar: 5 * 60_000,
  geo: 5 * 60_000,
  enso: 60 * 60_000,
  reports: 60_000,
  "locations/profile": 30 * 60_000,
};
export const WORKER_DATA_DEFAULT_TTL_MS = 5 * 60_000;
/** A failure is replayed for this long before the Worker is asked again. */
export const WORKER_DATA_FAILURE_TTL_MS = 20_000;
/** ...and a 429 for this long (asking sooner only makes it worse). */
export const WORKER_DATA_RATE_LIMITED_TTL_MS = 60_000;
/** Entries kept; the oldest settled one goes first. */
export const WORKER_DATA_MAX_ENTRIES = 80;
/** Retries of one call on a network error or 5xx, as the Worker client does. */
const DEFAULT_RETRIES = 1;

export type WorkerQuery = Record<string, string | number | undefined | null>;

/**
 * Why a read failed, in the terms a screen and a retry policy need (#414):
 *
 * - `rate_limited`: HTTP 429 (honour `retryAfterSeconds`)
 * - `timeout`: no answer in time
 * - `server`: HTTP 5xx, or the Worker could not be reached while the browser
 *   believes it is online
 * - `offline`: the browser reports no connection
 * - `invalid`: the Worker refused the request (4xx other than 429) or sent a
 *   body that is not what was asked for; asking again cannot help
 */
export type WorkerFailureKind =
  | "rate_limited"
  | "timeout"
  | "server"
  | "offline"
  | "invalid";

export interface WorkerFailure {
  kind: WorkerFailureKind;
  /** The HTTP status, or 0 when there was no answer at all. */
  status: number;
  /** From `Retry-After`, in seconds, when the Worker sent one. */
  retryAfterSeconds?: number;
}

/** Thrown by `json()`: the message is `HTTP <status>`, the detail is typed. */
export class WorkerDataError extends Error {
  readonly failure: WorkerFailure;
  constructor(failure: WorkerFailure) {
    super(
      failure.status > 0 ? `HTTP ${failure.status}` : `Worker ${failure.kind}`,
    );
    this.name = "WorkerDataError";
    this.failure = failure;
  }
}

/**
 * A 200 whose body says the Worker could not really answer: `available:
 * false` (haze, normals, the air-quality grid, ENSO), `degraded: true`
 * (history), the aviation card's `status: "unavailable"` and a `/v1/geo`
 * whose naming was skipped. The Worker marks these `no-store`; here they are
 * kept only briefly, so a recovery shows up on the next remount.
 */
export function isDegradedBody(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const d = data as {
    available?: unknown;
    degraded?: unknown;
    status?: unknown;
    nearest?: { namingSkipped?: unknown } | null;
  };
  return (
    d.available === false ||
    d.degraded === true ||
    d.status === "unavailable" ||
    d.nearest?.namingSkipped === true
  );
}

/** A `Retry-After` header (seconds or an HTTP date) as seconds, 0 to 600. */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const text = value.trim();
  let seconds: number;
  if (/^\d+$/.test(text)) seconds = Number(text);
  else {
    const at = Date.parse(text);
    if (!Number.isFinite(at)) return undefined;
    seconds = Math.ceil((at - now) / 1000);
  }
  return Math.min(600, Math.max(0, seconds));
}

/** Classify a transport error (nothing came back). */
export function classifyTransportError(
  error: unknown,
  online: boolean | undefined = typeof navigator !== "undefined"
    ? navigator.onLine
    : undefined,
): WorkerFailure {
  const name = (error as { name?: string } | null)?.name;
  if (name === "TimeoutError") return { kind: "timeout", status: 0 };
  if (online === false) return { kind: "offline", status: 0 };
  if (name === "AbortError") return { kind: "timeout", status: 0 };
  return { kind: "server", status: 0 };
}

/** Classify an HTTP answer that was not ok. */
export function classifyStatus(
  status: number,
  retryAfter?: string | null,
  now?: number,
): WorkerFailure {
  if (status === 429) {
    const retryAfterSeconds = parseRetryAfter(retryAfter, now);
    return {
      kind: "rate_limited",
      status,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    };
  }
  if (status >= 500) return { kind: "server", status };
  return { kind: "invalid", status };
}

/** What a read resolves to: the status, the parsed body, the provider label. */
export interface WorkerData<T = unknown> {
  ok: boolean;
  status: number;
  /** The parsed JSON body; null when the answer was not JSON or not ok. */
  data: T | null;
  /** `X-Weather-Provider`, when the Worker sent one. */
  provider: string | null;
  /** Set when `ok` is false: what went wrong, typed. */
  failure?: WorkerFailure;
}

export interface WorkerDataOptions {
  /** Stop WAITING (never cancels the shared request). */
  signal?: AbortSignal;
  /** Override the route's keep time. */
  ttlMs?: number;
  /** Retries of the underlying call on a network error / 5xx (default 1). */
  retries?: number;
  /** Per-attempt ceiling in ms (default: the Worker client's). */
  timeoutMs?: number;
  /** Key and send the coordinate exactly instead of the rounded cell. */
  exact?: boolean;
  /** Ignore a kept answer and read again (a user pressing refresh). */
  force?: boolean;
  /**
   * How long a failure is replayed (default 20 s; 60 s for a 429). 0 for a
   * read the visitor starts and may repeat at once (the GPS lookup).
   */
  failureTtlMs?: number;
}

interface Entry {
  promise: Promise<WorkerData>;
  /** The settled answer, once there is one (for `peek`). */
  value?: WorkerData;
  /** Infinity while the request is in flight. */
  expiresAt: number;
  startedAt: number;
}

export interface WorkerDataStoreInit {
  fetcher?: typeof fetch;
  now?: () => number;
  maxEntries?: number;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

/** Wait for `promise`, but give up (reject) when `signal` aborts. */
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function num(value: string | number | null | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The identity of a read and the query string it sends. */
export function workerDataKey(
  route: WorkerRoute,
  query: WorkerQuery,
  exact = false,
): { key: string; search: string } {
  const lat = num(query.lat);
  const lon = num(query.lon);
  const hasPoint = lat !== null && lon !== null;
  const rest = Object.entries(query)
    .filter(([k, v]) => k !== "lat" && k !== "lon" && v != null && v !== "")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const sent = new URLSearchParams();
  if (hasPoint) {
    sent.set("lat", String(exact ? lat : roundCoord(lat)));
    sent.set("lon", String(exact ? lon : roundCoord(lon)));
  }
  for (const [k, v] of rest) sent.set(k, String(v));
  // Rounded first, then snapped to the cell, so a caller that already rounded
  // and one that did not always land on the same key.
  const where = hasPoint
    ? exact
      ? `${lat},${lon}`
      : cellKey(roundCoord(lat), roundCoord(lon))
    : "-";
  const others = rest.map(([k, v]) => `${k}=${v}`).join("&");
  return { key: `${route}|${where}|${others}`, search: sent.toString() };
}

export interface WorkerDataStore {
  /** Read a route through the cache; resolves with the status and body. */
  read<T = unknown>(
    route: WorkerRoute,
    query: WorkerQuery,
    options?: WorkerDataOptions,
  ): Promise<WorkerData<T>>;
  /** Like `read`, but throws on anything that is not ok (HTTP n). */
  json<T = unknown>(
    route: WorkerRoute,
    query: WorkerQuery,
    options?: WorkerDataOptions,
  ): Promise<T>;
  /**
   * The settled answer for a read (good or failed, fresh or stale), or
   * undefined while nothing has settled. Never starts a request. Stable: the
   * same object until the read settles again, as `useSyncExternalStore`
   * needs.
   */
  peekSettled<T = unknown>(
    route: WorkerRoute,
    query: WorkerQuery,
    options?: Pick<WorkerDataOptions, "exact">,
  ): WorkerData<T> | undefined;
  /** Be told when any read settles, is invalidated or the store is reset. */
  subscribe: (listener: () => void) => () => void;
  /** A kept good answer, or undefined (never starts a request). */
  peek<T = unknown>(
    route: WorkerRoute,
    query: WorkerQuery,
    options?: Pick<WorkerDataOptions, "exact">,
  ): WorkerData<T> | undefined;
  /** Forget one read (after a write that makes it stale). */
  invalidate(
    route: WorkerRoute,
    query: WorkerQuery,
    options?: Pick<WorkerDataOptions, "exact">,
  ): void;
  /** Forget everything (tests, sign-out). */
  reset(): void;
  /** Requests started so far and entries held, for tests and diagnostics. */
  stats(): { requests: number; entries: number; inFlight: number };
}

export function createWorkerData({
  fetcher = (...args) => fetch(...args),
  now = () => Date.now(),
  maxEntries = WORKER_DATA_MAX_ENTRIES,
}: WorkerDataStoreInit = {}): WorkerDataStore {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let requests = 0;

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function evict(): void {
    if (entries.size < maxEntries) return;
    // Oldest settled entry first (Map keeps insertion order); never one that
    // is still in flight, which others may be waiting on.
    for (const [key, entry] of entries) {
      if (entry.expiresAt !== Infinity) {
        entries.delete(key);
        if (entries.size < maxEntries) return;
      }
    }
  }

  function start(
    key: string,
    route: WorkerRoute,
    search: string,
    ttlMs: number,
    retries: number,
    timeoutMs: number | undefined,
    failureTtlMs: number | undefined,
    previous: WorkerData | undefined,
  ): Entry {
    requests += 1;
    const entry: Entry = {
      promise: undefined as unknown as Promise<WorkerData>,
      // The answer being replaced stays visible (stale) until the new one
      // settles, so a section is not blanked while it refreshes.
      value: previous,
      expiresAt: Infinity,
      startedAt: now(),
    };
    entry.promise = (async (): Promise<WorkerData> => {
      let out: WorkerData;
      try {
        const res = await fetchWorker(
          route,
          search,
          { headers: { Accept: "application/json" } },
          { fetcher, retries, ...(timeoutMs ? { timeoutMs } : {}) },
        );
        let data: unknown = null;
        let parsed = res.ok;
        if (res.ok) {
          try {
            data = await res.json();
          } catch {
            parsed = false;
          }
        } else {
          await res.body?.cancel().catch(() => undefined);
        }
        const provider = res.headers?.get("X-Weather-Provider") ?? null;
        if (parsed) {
          out = { ok: true, status: res.status, data, provider };
        } else if (res.ok) {
          // A 200 that is not JSON (a challenge page, a proxy error): the
          // Worker did not answer what was asked.
          out = {
            ok: false,
            status: 502,
            data: null,
            provider,
            failure: { kind: "invalid", status: 502 },
          };
        } else {
          out = {
            ok: false,
            status: res.status,
            data: null,
            provider,
            failure: classifyStatus(
              res.status,
              res.headers?.get("Retry-After"),
              now(),
            ),
          };
        }
      } catch (err) {
        // Nothing came back (timeout, no connection): typed, not thrown, so
        // every caller reads the same failure.
        out = {
          ok: false,
          status: 0,
          data: null,
          provider: null,
          failure: classifyTransportError(err),
        };
      }
      // A good answer is kept for the route's time. A degraded one is not:
      // the seasonal estimate (`X-Weather-Provider: fallback`) or a body that
      // says `available: false` (haze, normals, the air-quality grid answer
      // 200 for an upstream outage) is replayed only briefly, so a recovery
      // shows up on the next remount instead of minutes later.
      const degraded = out.provider === "fallback" || isDegradedBody(out.data);
      // A refresh that fails (or comes back degraded) does not blank a good
      // answer the section is already showing: that stays on screen, stale,
      // and the failure only sets when the Worker is asked again. The callers
      // waiting on THIS read still get the typed failure.
      entry.value =
        previous?.ok && !isDegradedBody(previous.data) && (!out.ok || degraded)
          ? previous
          : out;
      const failureTtl = failureTtlMs ?? WORKER_DATA_FAILURE_TTL_MS;
      entry.expiresAt =
        now() +
        (out.ok && !degraded
          ? ttlMs
          : out.failure?.kind === "rate_limited"
            ? Math.max(
                failureTtlMs === undefined
                  ? WORKER_DATA_RATE_LIMITED_TTL_MS
                  : failureTtl,
                (out.failure.retryAfterSeconds ?? 0) * 1000,
              )
            : failureTtl);
      notify();
      return out;
    })();
    // A failure nobody awaits (every caller left) must not become an
    // unhandled rejection.
    entry.promise.catch(() => undefined);
    evict();
    entries.set(key, entry);
    return entry;
  }

  function read<T = unknown>(
    route: WorkerRoute,
    query: WorkerQuery,
    options: WorkerDataOptions = {},
  ): Promise<WorkerData<T>> {
    const { key, search } = workerDataKey(route, query, options.exact);
    const ttl =
      options.ttlMs ?? WORKER_DATA_TTL_MS[route] ?? WORKER_DATA_DEFAULT_TTL_MS;
    let entry = entries.get(key);
    let previous: WorkerData | undefined;
    if (entry && entry.expiresAt !== Infinity && entry.expiresAt <= now()) {
      previous = entry.value;
      entries.delete(key);
      entry = undefined;
    }
    if (entry && options.force && entry.expiresAt !== Infinity) {
      previous = entry.value;
      entries.delete(key);
      entry = undefined;
    }
    if (!entry)
      entry = start(
        key,
        route,
        search,
        ttl,
        options.retries ?? DEFAULT_RETRIES,
        options.timeoutMs,
        options.failureTtlMs,
        previous,
      );
    return waitFor(entry.promise, options.signal) as Promise<WorkerData<T>>;
  }

  async function json<T = unknown>(
    route: WorkerRoute,
    query: WorkerQuery,
    options?: WorkerDataOptions,
  ): Promise<T> {
    const res = await read<T>(route, query, options);
    if (!res.ok || res.data === null) {
      throw new WorkerDataError(
        res.failure ?? { kind: "invalid", status: res.status },
      );
    }
    return res.data;
  }

  return {
    read,
    json,
    peek<T = unknown>(
      route: WorkerRoute,
      query: WorkerQuery,
      options: Pick<WorkerDataOptions, "exact"> = {},
    ) {
      const { key } = workerDataKey(route, query, options.exact);
      const entry = entries.get(key);
      if (!entry || entry.expiresAt === Infinity || entry.expiresAt <= now()) {
        return undefined;
      }
      return entry.value?.ok ? (entry.value as WorkerData<T>) : undefined;
    },
    peekSettled<T = unknown>(
      route: WorkerRoute,
      query: WorkerQuery,
      options: Pick<WorkerDataOptions, "exact"> = {},
    ) {
      const { key } = workerDataKey(route, query, options.exact);
      return entries.get(key)?.value as WorkerData<T> | undefined;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    invalidate(route, query, options = {}) {
      entries.delete(workerDataKey(route, query, options.exact).key);
      notify();
    },
    reset() {
      entries.clear();
      requests = 0;
      notify();
    },
    stats() {
      let inFlight = 0;
      for (const e of entries.values())
        if (e.expiresAt === Infinity) inFlight++;
      return { requests, entries: entries.size, inFlight };
    },
  };
}

/** The page's store: one per browser tab (or server isolate). */
export const workerData: WorkerDataStore = createWorkerData();
