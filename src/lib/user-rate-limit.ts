/**
 * Per-user rate limiter on the shared Mongo `weather.rate_limits` collection
 * (unique on `key`, TTL-indexed on `expiresAt`; created by db-init).
 *
 * Fixed windows: the counter key carries the window number,
 * `${action}:user:${id}:${floor(now / window)}`, so a new window is a new
 * document and the limit resets on time whether or not Mongo's TTL reaper
 * has run (or the TTL index exists at all). The reaper only tidies old
 * windows: `expiresAt` is the window's end plus a grace period. A burst can
 * reach 2× the limit across one window boundary; that is the accepted cost
 * of a single atomic write per request.
 *
 * Like `check_rate_limit` in `api/py/_db.py` it FAILS OPEN on a DB error —
 * the limiter is abuse protection, and a DB outage must not take the route
 * down with it. (The Python limiter counts on one key per bucket and so
 * stays blocked until the reaper deletes the document; fixing it the same
 * way is a follow-up.)
 *
 * Keyed on a caller-chosen id (the WorkOS user id for /api/app-keys), never
 * on the IP: every request reaches the gateway from Vercel's shared egress.
 */

import { rateLimitsCollection } from "./db";

export interface RateLimitResult {
  allowed: boolean;
  /** Whole seconds until the window resets, 1–3600 (only when refused). */
  retryAfterSeconds?: number;
}

interface Counter {
  count?: number;
}

export type CounterStore = (
  key: string,
  expiresAt: Date,
) => Promise<Counter | null>;

/** Grace kept after a window ends before the reaper may delete it. */
export const WINDOW_GRACE_MS = 60_000;

function isDuplicateKey(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { code?: unknown }).code === 11000
  );
}

const mongoStore: CounterStore = async (key, expiresAt) => {
  const bump = () =>
    rateLimitsCollection().findOneAndUpdate(
      { key },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
      { upsert: true, returnDocument: "after" },
    );
  try {
    return (await bump()) as Counter | null;
  } catch (err) {
    // Two first requests in a window can both try to insert; the loser
    // gets E11000 and simply increments the winner's document.
    if (isDuplicateKey(err)) return (await bump()) as Counter | null;
    throw err;
  }
};

export async function checkUserRateLimit(
  action: string,
  userId: string,
  max: number,
  windowSeconds: number,
  store: CounterStore = mongoStore,
  now: () => number = Date.now,
): Promise<RateLimitResult> {
  const t = now();
  const windowMs = windowSeconds * 1000;
  const index = Math.floor(t / windowMs);
  const windowEnd = (index + 1) * windowMs;
  let doc: Counter | null;
  try {
    doc = await store(
      `${action}:user:${userId}:${index}`,
      new Date(windowEnd + WINDOW_GRACE_MS),
    );
  } catch {
    return { allowed: true }; // fail open, like the Python limiter
  }
  const count = doc?.count ?? 1;
  if (count <= max) return { allowed: true };
  const retryAfterSeconds = Math.min(
    3600,
    Math.max(1, Math.ceil((windowEnd - t) / 1000)),
  );
  return { allowed: false, retryAfterSeconds };
}
