/**
 * Location gate — decides, in the proxy, whether a `/{slug}` URL names a
 * location we can render (#263).
 *
 * Why the proxy and not the page: in Next.js 16 a `notFound()` thrown while
 * the HTML shell renders makes Next fall back to an empty
 * `<html id="__next_error__">` document. The status is a real 404, but the
 * not-found page only appears after the client hydrates, so visitors and
 * crawlers without JavaScript get a blank page. Throwing it inside a Suspense
 * boundary instead streams a 200 (the soft 404 from #237). Neither is right.
 * An unmatched URL (`/a/b/c`) does server-render the root not-found page with
 * a 404, so the proxy rewrites an unknown slug to an unmatched internal path
 * and Next serves exactly that.
 *
 * What renders (kept from #249):
 * - every shipped seed slug ("advertised means renderable"), with no lookup
 * - every smart-slug spot (`name--geohash`), which carries its own coordinate
 * - anything else that `resolveLocationSlug` resolves (community slugs,
 *   platform slugs, OSM place refs)
 */
import { LOCATIONS } from "./locations";
import { parseSmartSlug } from "./smart-slug";

/** Same pattern the proxy and the Python backend use for slugs. */
export const LOCATION_SLUG_RE = /^[a-z0-9-]{1,80}$/;

/** Sub-routes under `/[location]` (directories in src/app/[location]). */
export const LOCATION_SUB_ROUTES: ReadonlySet<string> = new Set([
  "atmosphere",
  "forecast",
  "map",
]);

/**
 * The internal path an unknown slug is rewritten to. It matches no route
 * (three segments, and the first is not a real top-level route), so Next
 * renders the root `not-found.tsx` with a 404 and full server HTML.
 */
export const LOCATION_NOT_FOUND_REWRITE = "/__mukoko/location/not-found";

const SEED_SLUGS: ReadonlySet<string> = new Set(LOCATIONS.map((l) => l.slug));

/**
 * Longest segment the gate looks up. Longer than {@link LOCATION_SLUG_RE}
 * allows, so an over-long slug still gets a lookup (which answers "unknown");
 * anything longer is 404'd without one.
 */
const MAX_GATED_SEGMENT = 200;

/** What the location gate needs to know about a request path. */
export type LocationPath =
  /** Not a gated `[location]` page: home, a known route, a deeper path, a
   * framework or tooling path (`_next`, `~offline`), or a segment that
   * isn't valid percent-encoding. */
  | { kind: "other" }
  /** A slug or sub-route in the wrong case (`/Harare`): redirect to `location`. */
  | { kind: "redirect"; location: string }
  /** A `[location]` page for `slug`, decoded the way the page's param is. */
  | { kind: "slug"; slug: string }
  /** Longer than any slug can be: a 404 with no lookup. */
  | { kind: "unknown" };

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Classify a request path. `/{segment}` and
 * `/{segment}/{atmosphere|forecast|map}` reach the `[location]` route unless
 * the segment is another top-level route (`knownRoutes`).
 * - Only the case is wrong (`/Harare`, `/harare/Forecast`): `redirect` to the
 *   lowercase URL, the canonical one (these used to render via the
 *   resolver's case-insensitive name lookup, so they must keep working).
 * - Otherwise `slug`, decoded exactly as the page receives its param, so the
 *   gate looks up what the page would (`/x_y`, `/z%C3%BCrich` too: the
 *   page's name lookup can resolve those, so they can't be 404'd unseen).
 * Deeper paths match no route and already get the server-rendered 404.
 */
export function classifyLocationPath(
  pathname: string,
  knownRoutes: ReadonlySet<string>,
): LocationPath {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0 || parts.length > 2) return { kind: "other" };
  const [segment, sub] = parts;
  if (knownRoutes.has(segment)) return { kind: "other" };
  if (segment.startsWith("_") || segment.startsWith("~")) {
    return { kind: "other" };
  }
  const lowerSub = sub?.toLowerCase();
  if (lowerSub !== undefined && !LOCATION_SUB_ROUTES.has(lowerSub)) {
    return { kind: "other" };
  }
  const slug = decodeSegment(segment);
  if (!slug) return { kind: "other" };
  if (slug.length > MAX_GATED_SEGMENT) return { kind: "unknown" };
  const lower = slug.toLowerCase();
  if (knownRoutes.has(lower)) {
    // `/Explore` → `/explore`; `/%65xplore` already IS the explore route.
    return lower !== slug && sub === undefined
      ? { kind: "redirect", location: `/${lower}` }
      : { kind: "other" };
  }
  if (lower !== slug || lowerSub !== sub) {
    return {
      kind: "redirect",
      location:
        "/" + [encodeURIComponent(lower), lowerSub].filter(Boolean).join("/"),
    };
  }
  return { kind: "slug", slug };
}

/**
 * True when the slug renders without any lookup: a shipped seed slug, or a
 * smart-slug spot. Both always render (seed fallback, coordinate in the URL).
 */
export function rendersWithoutLookup(slug: string): boolean {
  if (SEED_SLUGS.has(slug)) return true;
  const smart = parseSmartSlug(slug);
  return smart?.ref.kind === "spot";
}

/**
 * Must THROW on a database error rather than answer "not found", so the gate
 * can tell the two apart (`resolveLocationSlug(slug, { strict: true })`).
 */
type StrictResolver = (slug: string) => Promise<unknown>;

/** Positive answers are kept longer than negative ones, so a place created a
 * moment ago (create-on-demand) stops 404ing quickly. */
export const KNOWN_TTL_MS = 10 * 60_000;
export const UNKNOWN_TTL_MS = 15_000;
/** Real places and junk slugs live in separate buckets, so a scanner
 * requesting random paths can't evict the cached real places. */
export const MAX_KNOWN = 1000;
export const MAX_UNKNOWN = 200;
/** Past this the request is let through, so a hung cluster never stalls page
 * requests in the proxy. Generous enough to cover the first connection on a
 * cold instance (SRV lookup, TLS, auth); a lookup that overruns keeps going
 * in the background and caches its answer for the next request. */
export const LOOKUP_TIMEOUT_MS = 2500;

/** After a lookup fails, or times out twice in a row, skip lookups for this
 * long and let requests through: a struggling cluster then gets the page's
 * own lookup only, and requests don't each wait out the timeout. A single
 * timeout doesn't trigger it, because the first connection on a cold
 * instance can overrun the timeout while the cluster is healthy. */
export const DEGRADED_BACKOFF_MS = 10_000;
export const TIMEOUTS_BEFORE_BACKOFF = 2;

const known = new Map<string, number>();
const unknown = new Map<string, number>();
interface Lookup {
  promise: Promise<boolean>;
  /** Counted toward the backoff already (once per lookup, not per waiter). */
  timedOut: boolean;
}
/** One lookup per slug at a time, shared by concurrent requests. */
const inFlight = new Map<string, Lookup>();
/** Set once any lookup has settled: the connection has been made, so a
 * timeout after that is the cluster hanging, not a cold start. */
let connected = false;
let degradedUntil = 0;
let consecutiveTimeouts = 0;

/** Test hook. */
export function resetLocationGateCache(): void {
  known.clear();
  unknown.clear();
  inFlight.clear();
  degradedUntil = 0;
  consecutiveTimeouts = 0;
  connected = false;
}

function remember(
  bucket: Map<string, number>,
  max: number,
  slug: string,
  expires: number,
) {
  // Re-inserting moves the key to the newest slot; a refresh never evicts
  // an unrelated live entry.
  bucket.delete(slug);
  if (bucket.size >= max) {
    const oldest = bucket.keys().next().value;
    if (oldest !== undefined) bucket.delete(oldest);
  }
  bucket.set(slug, expires);
}

function fresh(
  bucket: Map<string, number>,
  slug: string,
  now: number,
): boolean {
  const expires = bucket.get(slug);
  if (expires === undefined || expires <= now) return false;
  // A hit moves the entry to the newest slot, so busy places outlive the
  // FIFO churn of one-off slugs (true LRU).
  bucket.delete(slug);
  bucket.set(slug, expires);
  return true;
}

const TIMED_OUT = Symbol("timeout");

export interface GateOptions {
  /** Request time; TTLs and the backoff count from it. */
  now?: number;
  timeoutMs?: number;
  /** Keeps a lookup that outlives the timeout running after the response
   * is sent (the proxy passes `event.waitUntil`), so it can still cache. */
  keepAlive?: (pending: Promise<unknown>) => void;
}

/**
 * Whether `slug` names a location we can render.
 *
 * Returns `null` when the lookup failed, timed out, or is backed off: the
 * caller must then let the request through, so a database problem never
 * turns a real place into a 404 (the page's own lookup and the seed fallback
 * still apply). Failures and timeouts are never cached as answers.
 */
export async function isRenderableLocation(
  slug: string,
  resolve: StrictResolver,
  {
    now = Date.now(),
    timeoutMs = LOOKUP_TIMEOUT_MS,
    keepAlive,
  }: GateOptions = {},
): Promise<boolean | null> {
  if (rendersWithoutLookup(slug)) return true;
  if (fresh(known, slug, now)) return true;
  if (fresh(unknown, slug, now)) return false;
  if (now < degradedUntil) return null;

  // The lookup records its own answer when it settles, so one that outlives
  // the timeout still warms the cache for the next request. A failure
  // records nothing but starts the backoff.
  let entry = inFlight.get(slug);
  if (!entry) {
    // TTLs and the backoff count from when the lookup SETTLES, on the
    // request's clock: a lookup that took 30 s to fail must still back off.
    const startedAt = Date.now();
    const settledAt = () => now + (Date.now() - startedAt);
    const promise = resolve(slug)
      .then(
        (found) => {
          connected = true;
          consecutiveTimeouts = 0;
          if (found != null) {
            remember(known, MAX_KNOWN, slug, settledAt() + KNOWN_TTL_MS);
            return true;
          }
          remember(unknown, MAX_UNKNOWN, slug, settledAt() + UNKNOWN_TTL_MS);
          return false;
        },
        (err: unknown) => {
          degradedUntil = settledAt() + DEGRADED_BACKOFF_MS;
          throw err;
        },
      )
      .finally(() => inFlight.delete(slug));
    entry = { promise, timedOut: false };
    inFlight.set(slug, entry);
  }
  const current = entry;
  const lookup = current.promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      lookup,
      new Promise<typeof TIMED_OUT>((r) => {
        timer = setTimeout(() => r(TIMED_OUT), timeoutMs);
      }),
    ]);
    if (result === TIMED_OUT) {
      keepAlive?.(lookup.catch(() => {}));
      // Before any lookup has settled, a timeout is the cold first
      // connection. After that, repeated timeouts with nothing answering in
      // between mean the cluster is hanging. Each lookup counts once, however
      // many requests waited on it.
      if (connected && !current.timedOut) {
        current.timedOut = true;
        consecutiveTimeouts += 1;
        if (consecutiveTimeouts >= TIMEOUTS_BEFORE_BACKOFF) {
          degradedUntil = now + timeoutMs + DEGRADED_BACKOFF_MS;
        }
      }
      return null;
    }
    return result;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    // A lookup still running after the timeout may reject later; that
    // rejection is expected and must not surface as unhandled.
    lookup.catch(() => {});
  }
}
