/**
 * Client for the signed-in agriculture AI text (`/api/ai/agriculture`).
 *
 * The card remounts often (LazySection unloads it off-screen; swiping between
 * saved places mounts a fresh one), and every POST counts against the
 * server's per-IP AI limit. So results are kept in memory per request body
 * for 10 minutes and concurrent identical requests share one fetch.
 */

import type {
  AgriAIMode,
  AgriAIResponse,
  AgricultureResponse,
} from "./agriculture";

export const AGRI_AI_CLIENT_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 50;

interface AgriAIRequestLocation {
  slug: string;
  name: string;
  country?: string;
  elevation?: number;
  lat: number;
  lon: number;
}

/** Stable JSON body (also the cache key) for one AI request. */
export function agriAIBody(
  location: AgriAIRequestLocation,
  activities: readonly string[],
  mode: AgriAIMode,
): string {
  return JSON.stringify({
    location: {
      slug: location.slug,
      name: location.name,
      country: location.country ?? "",
      elevation: location.elevation,
      lat: location.lat,
      lon: location.lon,
    },
    activities,
    mode,
  });
}

const cache = new Map<string, { text: string; at: number }>();
const inflight = new Map<string, Promise<string>>();

/** Cached text for a body, or undefined when absent or stale. */
export function peekAgriAI(body: string, now = Date.now()): string | undefined {
  const hit = cache.get(body);
  if (!hit) return undefined;
  if (now - hit.at > AGRI_AI_CLIENT_TTL_MS) {
    cache.delete(body);
    return undefined;
  }
  return hit.text;
}

/**
 * POST the body once (deduplicated), cache non-empty text. Rejects on HTTP
 * errors and on empty text so callers show their "unavailable" copy.
 */
export function fetchAgriAI(
  body: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const cached = peekAgriAI(body);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = inflight.get(body);
  if (pending) return pending;
  const request = fetcher("/api/ai/agriculture", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as AgriAIResponse;
      const text = (json.text ?? "").trim();
      if (!text) throw new Error("empty");
      if (cache.size >= MAX_ENTRIES) cache.clear();
      cache.set(body, { text, at: Date.now() });
      return text;
    })
    .finally(() => inflight.delete(body));
  inflight.set(body, request);
  return request;
}

/** Test hook. */
export function resetAgriAICache(): void {
  cache.clear();
  inflight.clear();
  dataCache.clear();
  dataInflight.clear();
}

// ---------------------------------------------------------------------------
// Public deterministic data (shared by the card and the insights page)
// ---------------------------------------------------------------------------

export const AGRI_DATA_CLIENT_TTL_MS = 5 * 60 * 1000;
const dataCache = new Map<string, { value: AgricultureResponse; at: number }>();
const dataInflight = new Map<string, Promise<AgricultureResponse>>();

/** GET `/api/py/agriculture…` once per URL (5-min memory cache + dedupe). */
export function fetchAgriculture(
  url: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<AgricultureResponse> {
  const hit = dataCache.get(url);
  if (hit && now - hit.at <= AGRI_DATA_CLIENT_TTL_MS)
    return Promise.resolve(hit.value);
  const pending = dataInflight.get(url);
  if (pending) return pending;
  const request = fetcher(url)
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const value = (await res.json()) as AgricultureResponse;
      // Only usable answers are kept; an outage should retry next mount.
      if (value.available) {
        if (dataCache.size >= MAX_ENTRIES) dataCache.clear();
        dataCache.set(url, { value, at: Date.now() });
      }
      return value;
    })
    .finally(() => dataInflight.delete(url));
  dataInflight.set(url, request);
  return request;
}
