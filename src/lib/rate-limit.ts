/**
 * MongoDB-backed rate limiter for abuse prevention.
 *
 * Uses a `rate_limits` collection with TTL index for automatic cleanup.
 */

import { rateLimitsCollection } from "./db";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}

/**
 * Check and increment a rate limit counter.
 *
 * @param ip - Client IP address
 * @param action - Action being rate-limited (e.g., "location-create")
 * @param maxRequests - Maximum requests allowed in the window
 * @param windowSeconds - Time window in seconds
 */
export async function checkRateLimit(
  ip: string,
  action: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const key = `${action}:${ip}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + windowSeconds * 1000);

  const result = await rateLimitsCollection().findOneAndUpdate(
    { key },
    {
      $inc: { count: 1 },
      $setOnInsert: { expiresAt },
    },
    { upsert: true, returnDocument: "after" },
  );

  const doc = result;
  const count = doc?.count ?? 1;
  const docExpiry = doc?.expiresAt ?? expiresAt;

  return {
    allowed: count <= maxRequests,
    remaining: Math.max(0, maxRequests - count),
    resetAt: docExpiry,
  };
}
