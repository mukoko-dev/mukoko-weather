/**
 * Bare-name fallback (#317): an unknown single-segment URL such as
 * `/koh-samui` or `/lake-kariba` is a place name, not a 404.
 *
 * The coordinate is the identity and the name in a URL is cosmetic, so the
 * proxy asks the Rust weather Worker (`GET /v1/search?mode=resolve` at
 * `weather-api.mukoko.com`: Open-Meteo forward geocoding behind its KV cache,
 * negative cache and rate limits) for the best match and 308-redirects to
 * the canonical smart slug `{name}--{geohash7}`. Only when nothing is found,
 * or the geocoder is over budget or unavailable, does the visitor get the
 * server-rendered 404.
 *
 * Vercel is frontend only and `api/py` is frozen, so the resolve exists only
 * in the Worker: with `NEXT_PUBLIC_WEATHER_API_URL` unset the feature is off
 * and every unknown slug 404s exactly as before (`src/lib/weather-api.ts`).
 *
 * Render-only: nothing is stored. The redirect target is a spot (or a
 * shipped seed), which renders from its slug alone.
 *
 * This runs in the proxy, so it must never stall a page request: a short
 * timeout, a per-instance positive and negative cache, one lookup per slug at
 * a time, a per-visitor cap and a backoff after any upstream trouble.
 */
import { LOCATION_SLUG_RE, rendersWithoutLookup } from "./location-gate";
import { weatherApiBase } from "./weather-api";

/** Shortest and longest name worth a geocoder request. */
export const BARE_NAME_MIN = 3;
export const BARE_NAME_MAX = 60;

/**
 * Words that are never place names in practice but are what scanners and
 * stale links request (`/admin`, `/wp-login`). Skipping them saves the
 * upstream call; the Python side still checks that a hit resembles the name.
 */
const NOT_A_PLACE: ReadonlySet<string> = new Set([
  "admin",
  "administrator",
  "login",
  "logout",
  "signin",
  "signup",
  "register",
  "account",
  "dashboard",
  "config",
  "configuration",
  "backup",
  "database",
  "debug",
  "test",
  "tests",
  "staging",
  "static",
  "assets",
  "public",
  "images",
  "cgi-bin",
  "phpmyadmin",
  "xmlrpc",
  "robots",
  "sitemap",
  "favicon",
  "manifest",
  "undefined",
  "null",
  "pricing",
]);

/**
 * True for a slug worth resolving as a bare place name: lowercase words
 * joined by single dashes (`koh-samui`), no smart-slug delimiter, not a
 * number, not a probe path.
 */
export function isBareNameCandidate(slug: string): boolean {
  if (slug.length < BARE_NAME_MIN || slug.length > BARE_NAME_MAX) return false;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return false;
  if (/^[0-9-]+$/.test(slug)) return false;
  if (slug.startsWith("wp-") || NOT_A_PLACE.has(slug)) return false;
  return true;
}

/** `koh-samui` → `koh samui`, the form the geocoder is asked for. */
export function bareNameQuery(slug: string): string {
  return slug.replace(/-+/g, " ").trim();
}

/** What the redirect may point at: a seed slug or a spot, never anything else. */
function acceptableTarget(target: unknown, from: string): string | null {
  if (typeof target !== "string" || target === from) return null;
  if (!LOCATION_SLUG_RE.test(target)) return null;
  return rendersWithoutLookup(target) ? target : null;
}

/** Positive answers live long (a name does not move); misses briefly, since
 * an empty answer can be a geocoder hiccup. */
export const BARE_HIT_TTL_MS = 6 * 3600_000;
export const BARE_MISS_TTL_MS = 10 * 60_000;
export const MAX_BARE_HITS = 500;
export const MAX_BARE_MISSES = 200;
/** The proxy waits at most this long, then 404s; the lookup finishes in the
 * background and caches its answer for the next request. */
export const BARE_TIMEOUT_MS = 1500;
/** After the geocoder is over budget, unavailable or failing, stop asking. */
export const BARE_BACKOFF_MS = 30_000;
/** Uncached lookups one visitor may start per minute, per instance. */
export const BARE_PER_VISITOR = 8;
export const BARE_VISITOR_WINDOW_MS = 60_000;
const MAX_VISITORS = 2000;

const hits = new Map<string, { target: string; expires: number }>();
const misses = new Map<string, number>();
const inFlight = new Map<string, Promise<string | null>>();
const visitors = new Map<string, { count: number; windowEnds: number }>();
let backoffUntil = 0;

/** Test hook. */
export function resetBareNameCache(): void {
  hits.clear();
  misses.clear();
  inFlight.clear();
  visitors.clear();
  backoffUntil = 0;
}

function remember<V>(bucket: Map<string, V>, max: number, key: string, v: V) {
  bucket.delete(key);
  if (bucket.size >= max) {
    const oldest = bucket.keys().next().value;
    if (oldest !== undefined) bucket.delete(oldest);
  }
  bucket.set(key, v);
}

function visitorAllowed(visitor: string, now: number): boolean {
  const entry = visitors.get(visitor);
  if (!entry || entry.windowEnds <= now) {
    remember(visitors, MAX_VISITORS, visitor, {
      count: 1,
      windowEnds: now + BARE_VISITOR_WINDOW_MS,
    });
    return true;
  }
  if (entry.count >= BARE_PER_VISITOR) return false;
  entry.count += 1;
  return true;
}

export interface BareNameOptions {
  now?: number;
  timeoutMs?: number;
  /** The visitor's address, for the per-visitor cap (never sent upstream). */
  visitor?: string;
  /** Lets a lookup that outlives the timeout finish and cache its answer. */
  keepAlive?: (pending: Promise<unknown>) => void;
  fetcher?: typeof fetch;
  env?: Record<string, string | undefined>;
}

interface ResolveResponse {
  locations?: Array<{ slug?: unknown }>;
  resolve?: string;
}

async function lookup(
  slug: string,
  now: number,
  fetcher: typeof fetch,
  env: Record<string, string | undefined> | undefined,
  timeoutMs: number,
): Promise<string | null> {
  const base = weatherApiBase(env);
  if (!base) return null;
  const url = `${base}/v1/search?mode=resolve&q=${encodeURIComponent(bareNameQuery(slug))}`;
  const controller = new AbortController();
  // The lookup has its own ceiling, longer than the proxy's wait, so a slow
  // answer still gets cached for the next request.
  const abort = setTimeout(() => controller.abort(), timeoutMs * 4);
  try {
    const res = await fetcher(url, {
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`resolve ${res.status}`);
    const body = (await res.json()) as ResolveResponse;
    if (body.resolve === "over_budget" || body.resolve === "unavailable") {
      backoffUntil = now + BARE_BACKOFF_MS;
      return null;
    }
    const target = acceptableTarget(body.locations?.[0]?.slug, slug);
    if (target) {
      remember(hits, MAX_BARE_HITS, slug, {
        target,
        expires: now + BARE_HIT_TTL_MS,
      });
      return target;
    }
    remember(misses, MAX_BARE_MISSES, slug, now + BARE_MISS_TTL_MS);
    return null;
  } catch {
    backoffUntil = now + BARE_BACKOFF_MS;
    return null;
  } finally {
    clearTimeout(abort);
  }
}

/**
 * The canonical slug for a bare place name, or null when there is none (no
 * match, over budget, unavailable, slow, or the caller asked too often). Never
 * throws and never stalls the request past `timeoutMs`.
 */
export async function resolveBareName(
  slug: string,
  {
    now = Date.now(),
    timeoutMs = BARE_TIMEOUT_MS,
    visitor = "unknown",
    keepAlive,
    fetcher = fetch,
    env,
  }: BareNameOptions = {},
): Promise<string | null> {
  if (!isBareNameCandidate(slug)) return null;
  // Off until the Worker is configured: nothing to ask, nothing to cache.
  if (!weatherApiBase(env)) return null;
  const hit = hits.get(slug);
  if (hit && hit.expires > now) return hit.target;
  const missExpires = misses.get(slug);
  if (missExpires !== undefined && missExpires > now) return null;
  if (now < backoffUntil) return null;

  let pending = inFlight.get(slug);
  if (!pending) {
    if (!visitorAllowed(visitor, now)) return null;
    pending = lookup(slug, now, fetcher, env, timeoutMs).finally(() =>
      inFlight.delete(slug),
    );
    inFlight.set(slug, pending);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const TIMED_OUT = Symbol("timeout");
  try {
    const result = await Promise.race([
      pending,
      new Promise<typeof TIMED_OUT>((r) => {
        timer = setTimeout(() => r(TIMED_OUT), timeoutMs);
      }),
    ]);
    if (result === TIMED_OUT) {
      keepAlive?.(pending.catch(() => {}));
      return null;
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}
