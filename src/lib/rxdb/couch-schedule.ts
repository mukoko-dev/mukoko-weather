/**
 * Timing rules of the CouchDB sync (pure: every function takes the clock or a
 * random source as an argument, none reads them).
 *
 * The credential is the gateway's sync grant: five minutes at most
 * (nyuchi-api `COUCH_SYNC_MAX_SECONDS`) and never longer than the WorkOS access
 * token it was made from, so the sync asks for a new one a minute before the
 * old one runs out, about every four minutes. The server side keeps every
 * grant at least `COUCH_MIN_ACCESS_TOKEN_LIFE_MS` long (`lib/couch-session-timing.ts`),
 * so a grant is never due the moment it arrives. A failure never retries
 * on a tight loop: the wait starts at 30 s, doubles, and stops at 15 minutes,
 * the same shape as the device-profile sync (`device-profile.ts`).
 */

import { REFRESH_MIN_DELAY_MS as SHARED_REFRESH_MIN_DELAY_MS } from "../couch-session-timing";

/** First wait after a failure. */
export const BACKOFF_START_MS = 30_000;
/** Longest wait between attempts. */
export const BACKOFF_MAX_MS = 15 * 60_000;
/** A new credential is requested this long before the old one expires. */
export const REFRESH_LEAD_MS = 60_000;
/**
 * Never schedule a refresh sooner than this (a clock that is badly off). The
 * constant is shared with the server side (`lib/couch-session-timing.ts`); the
 * engine applies it as a floor on every renewal timer, so a credential that is
 * already inside the lead window cannot make a loop.
 */
export const REFRESH_MIN_DELAY_MS = SHARED_REFRESH_MIN_DELAY_MS;
/** How often a visible page pulls and pushes while nothing else triggers it. */
export const POLL_INTERVAL_MS = 60_000;
/** A focus or visibility trigger within this of the last run is ignored. */
export const FOCUS_COOLDOWN_MS = 15_000;
/** A local change waits this long to be written (one burst, one write). */
export const LOCAL_WRITE_DEBOUNCE_MS = 750;
/** After a local write, the push waits this long for further changes. */
export const PUSH_DEBOUNCE_MS = 2_000;

/**
 * Milliseconds from `nowMs` until the credential should be refreshed: the
 * expiry minus the lead, never below `REFRESH_MIN_DELAY_MS`, and `0` when it
 * is already inside the lead window (refresh now). An unusable expiry
 * (`NaN`, past) means "refresh now". The engine never arms a timer with less
 * than `REFRESH_MIN_DELAY_MS`, so "now" is at the soonest that far away.
 */
export function refreshDelayMs(expiresAtMs: number, nowMs: number): number {
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) return 0;
  const untilExpiry = expiresAtMs - nowMs;
  if (untilExpiry <= REFRESH_LEAD_MS) return 0;
  return Math.max(REFRESH_MIN_DELAY_MS, untilExpiry - REFRESH_LEAD_MS);
}

/**
 * When to arm the renewal timer: `refreshDelayMs`, but never sooner than
 * `REFRESH_MIN_DELAY_MS`, so two credential fetches are never closer than that
 * whatever the credential's expiry says (already inside the lead window, a
 * clock that is off). The engine arms its timer with this and nothing else.
 */
export function renewalDelayMs(expiresAtMs: number, nowMs: number): number {
  return Math.max(REFRESH_MIN_DELAY_MS, refreshDelayMs(expiresAtMs, nowMs));
}

/** True while the credential can still be used for a request that takes `slackMs`. */
export function isTokenUsable(
  expiresAtMs: number,
  nowMs: number,
  slackMs: number = REFRESH_MIN_DELAY_MS,
): boolean {
  return Number.isFinite(expiresAtMs) && expiresAtMs - nowMs > slackMs;
}

/**
 * The wait after the `failures`-th consecutive failure (1-based): 30 s,
 * 60 s, 2 min ... capped at 15 min. `random` in [0, 1) spreads devices by
 * +-10 % so a recovering service is not met by every device at one instant;
 * pass `() => 0.5` for the exact value.
 */
export function backoffDelayMs(
  failures: number,
  random: () => number = Math.random,
): number {
  const n = Math.max(1, Math.floor(failures));
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** (n - 1));
  const spread = 0.9 + random() * 0.2; // 0.9 .. 1.1
  return Math.min(BACKOFF_MAX_MS, Math.round(base * spread));
}

/** What a failed attempt means for the engine. */
export type FailureAction =
  | "refetch_token_once" // 401: the credential was refused; ask again once
  | "back_off" // everything else that may pass on its own
  | "stay_idle"; // signed out: nothing to sync until sign-in

/**
 * Decides what to do after a failure. `status` is the HTTP status when there
 * is one (0 or undefined: no response, i.e. offline, DNS, timeout).
 * `alreadyRefetched` is true when this attempt already used its one refetch.
 *
 * 401 from CouchDB's side: the grant was refused (expired early, or the
 * gateway's key rotated), so fetch a new one once; a second 401 is a real problem
 * and backs off. 401 from OUR session route means the person is signed out.
 * 403, 404, 429, 5xx and network errors all back off.
 */
export function failureAction(
  source: "route" | "couch",
  status: number | undefined,
  alreadyRefetched: boolean,
): FailureAction {
  if (status === 401) {
    if (source === "route") return "stay_idle";
    return alreadyRefetched ? "back_off" : "refetch_token_once";
  }
  return "back_off";
}
