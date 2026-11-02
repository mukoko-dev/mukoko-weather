/**
 * Server-only: the one function that turns a signed-in visitor into a
 * credential for their own CouchDB database. **It has no implementation
 * yet, and that is deliberate.**
 *
 * WHY. The route that would call the gateway (`POST /v1/couch/session`,
 * nyuchi-api `gateway/routers/couch.py`) takes "the person's own sign-in only",
 * and this site cannot produce one (verified against nyuchi-api `main` at
 * 78f2e6f, api.nyuchi.com v0.51.0):
 *
 *   - `couch.py:163` and `couch_proxy.py:101` refuse any token that carries
 *     `scope` or `act`. Every token this app can get is one: the RFC 8693
 *     exchange (`gateway-person-token.ts`) always issues `scope` and `act`
 *     (`routers/auth.py` `_exchange_token` -> `create_platform_jwt(scopes=...,
 *     actor_client_id=...)`, `lib/jwt.py` writes both claims).
 *   - `couch` is in `NON_DELEGABLE_SCOPES` (`lib/token_exchange.py:90-93`), so
 *     no exchange can ever grant it, to this key or any other.
 *   - The sign-in token (no `scope`, no `act`) is minted only by
 *     `/v1/auth/workos/callback` to a registered auth-app origin
 *     (`routers/workos.py`); this site signs in through its own AuthKit
 *     session and never holds one.
 *
 * WHAT IS NEEDED (decided by the identity session / owner, not here): either
 * a narrow, person-only sync grant the exchange may issue and the two couch
 * routes accept, or registering weather.mukoko.com as an auth-app so the
 * browser can hold a sign-in token. See the PR and nyuchi/nyuchi-api for the
 * options. Whichever it is, it is implemented HERE, behind this interface;
 * nothing else in the app changes.
 *
 * Until then `couchSessionIssuer()` is null and `/api/couch/session` answers
 * 503 `couch_unavailable` after its sign-in, same-origin and rate-limit
 * guards. Nothing calls the gateway, and no credential is invented.
 */

export interface IssuedCouchCredential {
  /** The short-lived bearer the browser replicates with. Never logged. */
  token: string;
  expiresAtMs: number;
  /** `user_<personId>`. */
  database: string;
}

export type CouchIssueErrorCode =
  | "reauth_required" // the WorkOS session ended
  | "account_pending_deletion"
  | "rate_limited"
  | "couch_unavailable";

const STATUS: Record<CouchIssueErrorCode, number> = {
  reauth_required: 401,
  account_pending_deletion: 403,
  rate_limited: 429,
  couch_unavailable: 503,
};

export class CouchIssueError extends Error {
  readonly status: number;
  constructor(
    readonly code: CouchIssueErrorCode,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = "CouchIssueError";
    this.status = STATUS[code];
  }
}

export interface CouchSessionIssuer {
  issue(who: {
    userId: string;
    accessToken?: string;
  }): Promise<IssuedCouchCredential>;
}

/** The configured issuer, or null: today always null (see the header). */
export function couchSessionIssuer(): CouchSessionIssuer | null {
  return null;
}
