/**
 * Per-user rate limiter on the shared Mongo `weather.rate_limits` collection
 * (TTL-indexed on `expiresAt`, unique on `key`; created by db-init). Same
 * semantics as `check_rate_limit` in `api/py/_db.py`: one atomic upsert that
 * increments a counter for the window, and it FAILS OPEN on any DB error —
 * the limiter is abuse protection, and a DB outage must not take the route
 * down with it.
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
  expiresAt?: Date;
}

export type CounterStore = (
  key: string,
  expiresAt: Date,
) => Promise<Counter | null>;

const mongoStore: CounterStore = async (key, expiresAt) =>
  (await rateLimitsCollection().findOneAndUpdate(
    { key },
    { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
    { upsert: true, returnDocument: "after" },
  )) as Counter | null;

export async function checkUserRateLimit(
  action: string,
  userId: string,
  max: number,
  windowSeconds: number,
  store: CounterStore = mongoStore,
  now: () => number = Date.now,
): Promise<RateLimitResult> {
  const t = now();
  let doc: Counter | null;
  try {
    doc = await store(
      `${action}:user:${userId}`,
      new Date(t + windowSeconds * 1000),
    );
  } catch {
    return { allowed: true }; // fail open, like the Python limiter
  }
  const count = doc?.count ?? 1;
  if (count <= max) return { allowed: true };
  const resetMs =
    doc?.expiresAt instanceof Date
      ? doc.expiresAt.getTime() - t
      : windowSeconds * 1000;
  const retryAfterSeconds = Math.min(
    3600,
    Math.max(1, Math.ceil(resetMs / 1000)),
  );
  return { allowed: false, retryAfterSeconds };
}
