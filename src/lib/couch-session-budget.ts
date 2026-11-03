/**
 * Server-only: the site-wide budget for sync grants (mukoko-dev/mukoko-weather#396).
 *
 * WHY. Every grant is a fresh exchange at the gateway's token endpoint
 * (`POST /v1/auth/token`, `maxCacheMs: 0` in `couch-session-issuer.ts`), made
 * with this site's ONE key, and `/api/app-keys` makes its exchanges with the
 * same key. The gateway limits that endpoint to **30 a minute per key**
 * (nyuchi-api `gateway/lib/security.py` `token_endpoint_limit`, l.214-223; see
 * docs/couchdb-sync.md). The per-person limit of the route (120 an hour) does
 * not protect the key: a few hundred people with the flag on, each renewing
 * every four minutes, would take the whole minute from developers managing
 * their API keys, who never turned sync on. So the sync route spends from a
 * budget of its own, one counter for the whole site, and leaves the rest to
 * `/api/app-keys`.
 *
 * THE ARITHMETIC. The gateway allows 30 a minute. The sync budget is
 * `COUCH_SYNC_BUDGET` = 6 every 20 seconds:
 *
 *   - sustained: 6 x 3 = 18 a minute, so at least 12 a minute remain;
 *   - worst case: a fixed window can pass its whole limit at its very end and
 *     again at the very start of the next one, so ANY 60 seconds overlaps at
 *     most 4 windows of 20 s (partly the first and last, wholly two between):
 *     4 x 6 = 24. At least 6 of the 30 are therefore always left to
 *     `/api/app-keys` (its own per-person limits are 10 a minute for the list).
 *
 *   A single 60-second window of 18 would look the same sustained but allow 36
 *   in a minute across a boundary, which is over the gateway's 30. Smaller
 *   windows are what bound the worst case. (One counter document is written
 *   per request; under heavy load that is a hot document, accepted: the number
 *   of requests it limits is small.)
 *
 * SEPARATE COUNTERS. The counter is `couch-session-global:user:all:<window>` in
 * the same Mongo collection and with the same limiter as the per-person ones
 * (`checkUserRateLimit`); `/api/app-keys` counts under `app-keys-<action>:user:<id>`,
 * so neither can take from the other, and a test pins it.
 *
 * THE GATEWAY'S OWN 429. If the gateway answers 429 anyway (the key's ceiling
 * was reached by something this budget does not see: another instance's
 * `/api/app-keys` traffic, other apps), the route notes it
 * (`noteGatewayRateLimit`) and this instance sends no more sync exchanges until
 * the time the gateway named has passed (at most `GATEWAY_COOLDOWN_MAX_SECONDS`),
 * answering 429 with `Retry-After` itself. That also holds when Mongo is down:
 * the counter then fails open, like the per-person limit (abuse protection must
 * not take sync down with it), and this memory is the second line. It is per
 * instance, not shared.
 *
 * Nothing here logs a person, a token or a key.
 */

import { checkUserRateLimit, type RateLimitResult } from "./user-rate-limit";

/** The gateway's ceiling for the token endpoint, per key (security.py l.214-223). */
export const GATEWAY_TOKEN_LIMIT_PER_MINUTE = 30;

/** [max exchanges, window seconds]: see "the arithmetic" above. */
export const COUCH_SYNC_BUDGET = [6, 20] as const;

/** The counter's action and id: one counter for the whole site. */
export const COUCH_SYNC_BUDGET_ACTION = "couch-session-global";
const COUCH_SYNC_BUDGET_ID = "all";

/** How long this instance stops after the gateway said 429, at most. */
export const GATEWAY_COOLDOWN_MAX_SECONDS = 30;
/** ...and when the gateway named no time. */
const GATEWAY_COOLDOWN_DEFAULT_SECONDS = 20;

export type SyncSpend =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export interface SyncBudget {
  /** Take one exchange from the site-wide budget, or say when to try again. */
  spend(): Promise<SyncSpend>;
  /**
   * The gateway answered 429 to an exchange: send no more for a while. Returns
   * true when this began a cooldown (the caller logs it once), false when one
   * was already running that ends no sooner.
   */
  noteGatewayRateLimit(retryAfterSeconds?: number): boolean;
}

export function createSyncBudget(
  deps: {
    check?: (
      action: string,
      id: string,
      max: number,
      windowSeconds: number,
    ) => Promise<RateLimitResult>;
    now?: () => number;
  } = {},
): SyncBudget {
  const check = deps.check ?? checkUserRateLimit;
  const now = deps.now ?? Date.now;
  let coolingUntil = 0;

  return {
    async spend() {
      const t = now();
      if (t < coolingUntil) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((coolingUntil - t) / 1000)),
        };
      }
      const [max, windowSeconds] = COUCH_SYNC_BUDGET;
      const answer = await check(
        COUCH_SYNC_BUDGET_ACTION,
        COUCH_SYNC_BUDGET_ID,
        max,
        windowSeconds,
      );
      if (answer.allowed) return { allowed: true };
      return {
        allowed: false,
        retryAfterSeconds: answer.retryAfterSeconds ?? windowSeconds,
      };
    },

    noteGatewayRateLimit(retryAfterSeconds) {
      const asked =
        typeof retryAfterSeconds === "number" &&
        Number.isFinite(retryAfterSeconds) &&
        retryAfterSeconds > 0
          ? retryAfterSeconds
          : GATEWAY_COOLDOWN_DEFAULT_SECONDS;
      const seconds = Math.min(asked, GATEWAY_COOLDOWN_MAX_SECONDS);
      const until = now() + seconds * 1000;
      if (until <= coolingUntil) return false;
      const began = now() >= coolingUntil;
      coolingUntil = until;
      return began;
    },
  };
}

/** The one budget of this process (the route's). */
export const syncBudget: SyncBudget = createSyncBudget();
