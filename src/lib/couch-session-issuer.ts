/**
 * Server-only: the one function that turns a signed-in visitor into a
 * credential for their own CouchDB database (mukoko-dev/mukoko-weather#396).
 *
 * THE CREDENTIAL is the gateway's CouchDB SYNC GRANT (nyuchi/nyuchi-api #475,
 * `docs/architecture/couchdb-sync-grant.md`, released in v0.53.0): a
 * short-lived token whose only power is to replicate the caller's OWN private
 * database `user_<personId>` and to prepare it (`POST /v1/couch/personal`).
 * The site's SERVER asks for it, with the person's own WorkOS access token
 * (the same RFC 8693 exchange `/api/app-keys` uses, `gateway-person-token.ts`),
 * and returns it to the page as the replication bearer. A full sign-in token
 * never reaches page JavaScript, and the browser never sees the WorkOS token.
 *
 *   POST {gateway}/v1/auth/token
 *     grant_type=urn:ietf:params:oauth:grant-type:token-exchange
 *     subject_token=<WorkOS access token from withAuth()>
 *     subject_token_type=urn:ietf:params:oauth:token-type:access_token
 *     scope=couch:user                    <- requested ALONE, or it is refused
 *     client_id / client_secret           <- this app's internal key
 *
 * Verified against nyuchi-api `staging` (read 2026-11-03, after v0.53.0):
 *
 *   - Scope alone, and only for an allow-listed client: `check_sync_request`
 *     (`gateway/lib/token_exchange.py` l.614-632) refuses anything but exactly
 *     `couch:user` and any client not in `COUCH_SYNC_CLIENT_IDS`. That list is
 *     the exchanging KEY's client id (`nyk_...`, the public half of
 *     `NYUCHI_APP_KEYS_API_KEY`): `routers/auth.py` l.351 passes
 *     `ctx.get("client_id")`, and the grant's `act.sub` is that same id
 *     (`lib/jwt.py` `create_couch_sync_token` l.373-388). It is NOT a WorkOS
 *     client id. The key needs no new scope: the allow-list is the grant (the
 *     key API refuses a scope outside its catalogue), so the key this app
 *     already uses (internal, scope `identity`) is enough once its client id
 *     is listed. Without the listing the exchange answers 400 `invalid_scope`.
 *   - The subject token is checked exactly as for any exchange
 *     (`verify_subject_token`, l.369-441): issued to the gateway's
 *     `WORKOS_CONSOLE_CLIENT_ID`, which is the Mukoko Account client this app
 *     signs in through (`WORKOS_CLIENT_ID`). A token from another client is
 *     refused HERE before it leaves the server, as `/api/app-keys` does.
 *   - Lifetime: `min(300 s, the subject token's remaining life)`
 *     (`sync_lifetime` l.635-637), audience `couch-sync`, no refresh, never
 *     accepted as a sign-in. The page renews it with a new exchange, so this
 *     issuer never serves a grant twice (`maxCacheMs: 0`): a cached grant with
 *     a minute left would be due the moment it arrived.
 *   - Accepted only on `/v1/couch/db/user_<own id>/...` and
 *     `POST /v1/couch/personal` (`routers/couch.py` `get_couch_caller` l.76-94,
 *     `routers/couch_proxy.py` l.105-110). `POST /v1/couch/session` refuses it.
 *   - Errors (`routers/auth.py` `_issue_sync_grant` l.487-540): a scheduled
 *     deletion is 400 `invalid_grant` with the description "This person's
 *     deletion is scheduled." (the only difference on the wire from an ended
 *     session, matched by `isScheduledDeletion`), 429 `slow_down` past 30
 *     exchanges a minute per person, 503 when the sign-in key is missing.
 *
 * Fail closed. Without `NYUCHI_API_URL` (a bare https origin), the app's key
 * or `WORKOS_CLIENT_ID`, `couchSessionIssuer()` is null and the route answers
 * 503 `couch_unavailable` without calling anything. No new secret and no new
 * environment variable: this is the key `/api/app-keys` already holds. The
 * grant, the WorkOS token and the key are never logged.
 *
 * Nothing here has run against the live gateway or a real CouchDB: the
 * gateway's rules are exercised through the fake in
 * `src/lib/test-support/fake-nyuchi-gateway.ts`.
 */

import {
  SIGNED_OUT_CODE,
  personIdFromDatabase,
} from "./couch-session-contract";
import {
  consoleClientId,
  createPersonTokenExchanger,
  peekClaims,
  PersonTokenError,
  type ExchangerOptions,
  type PersonToken,
} from "./gateway-person-token";
import { gatewayConfig } from "./nyuchi-gateway";
import { logWarn } from "./observability";
import { COUCH_MIN_ACCESS_TOKEN_LIFE_MS } from "./couch-session-timing";

/** The grant's scope, audience and longest life (`lib/jwt.py` l.368-370). */
export const COUCH_SYNC_SCOPE = "couch:user";
export const COUCH_SYNC_AUDIENCE = "couch-sync";
export const COUCH_SYNC_MAX_SECONDS = 300;

export interface IssuedCouchCredential {
  /** The short-lived bearer the browser replicates with. Never logged. */
  token: string;
  /**
   * How long it lives from now, in whole seconds, counted on THIS server's
   * clock at the moment of issue (rounded down: never a moment the grant no
   * longer has). The page gets a duration, not a time of day, because its
   * clock is not this one (a few minutes off is common) and the grant is only
   * five minutes long. The grant's own `exp` is the server-side check.
   */
  expiresInSeconds: number;
  /** `user_<personId>`. */
  database: string;
}

/**
 * `signed_out` is the one code with a 401, and it means exactly one thing:
 * nobody is signed in (`SIGNED_OUT_CODE`, the code the page matches before it
 * removes its local copy of the person's settings). Everything the gateway or
 * the WorkOS token can say about a person who IS signed in is a retry
 * (`couch_unavailable`, 503), or one of the two explicit refusals below.
 */
export type CouchIssueErrorCode =
  | typeof SIGNED_OUT_CODE
  | "account_pending_deletion"
  | "rate_limited"
  | "couch_unavailable";

const STATUS: Record<CouchIssueErrorCode, number> = {
  [SIGNED_OUT_CODE]: 401,
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

/**
 * The gateway words a scheduled deletion as `invalid_grant` + this sentence
 * (`routers/auth.py` l.514-517). Matching the text is the only way to tell it
 * from an ended session; if the words change, the person is told to sign in
 * again, which is safe, and `couch-session-issuer.test.ts` names the sentence.
 */
export function isScheduledDeletion(description: string | null): boolean {
  return !!description && /deletion is scheduled/i.test(description);
}

/**
 * The exchanger for the sync grant: the app-keys exchanger with the scope
 * `couch:user`, no reuse of a grant between requests, and the scheduled
 * deletion told apart. `options` are the transport and the client check
 * (`config`, `consoleClientId`, optionally `now`); the rest is fixed here.
 */
export function createCouchGrantExchanger(
  options: Pick<ExchangerOptions, "config" | "consoleClientId" | "now">,
) {
  return createPersonTokenExchanger({
    ...options,
    scope: COUCH_SYNC_SCOPE,
    maxCacheMs: 0,
    pendingDeletion: isScheduledDeletion,
  });
}

export interface GrantSource {
  getPersonToken(
    userId: string,
    accessToken: string | undefined,
  ): Promise<PersonToken>;
}

function mapExchangeError(err: unknown): unknown {
  if (!(err instanceof PersonTokenError)) return err;
  switch (err.code) {
    case "account_pending_deletion":
      return new CouchIssueError("account_pending_deletion");
    case "rate_limited":
      return new CouchIssueError("rate_limited", err.retryAfterSeconds);
    default:
      // reauth_required (the gateway refusing the WorkOS token: a revoked or
      // skewed one, a client mismatch, an operator misconfiguration),
      // gateway_unconfigured, wrong_workos_client, exchange_refused,
      // person_not_provisioned, gateway_unavailable. The route has just seen a
      // person signed in, so none of this is "signed out": sync is not
      // available for them right now, the page keeps its local copy and backs
      // off. A session that really ended is the route's own 401 (no user),
      // which comes first and never reaches the gateway.
      return new CouchIssueError("couch_unavailable");
  }
}

/**
 * What the gateway handed back, reduced to the credential. The token is read
 * (not verified: the gateway signed it and it came straight from there) only
 * to learn WHICH person it is for, because the exchange answer does not say.
 * Anything that does not look exactly like a sync grant is refused, so a
 * gateway that starts answering something else cannot reach the page.
 */
function toCredential(
  grant: PersonToken,
  nowMs: number,
): IssuedCouchCredential {
  const bad = () => new CouchIssueError("couch_unavailable");
  const claims = peekClaims(grant.token);
  if (!claims) throw bad();
  const sub = claims.sub;
  const act = claims.act;
  const iat = claims.iat;
  const exp = claims.exp;
  if (
    claims.aud !== COUCH_SYNC_AUDIENCE ||
    claims.scope !== COUCH_SYNC_SCOPE ||
    typeof sub !== "string" ||
    !act ||
    typeof act !== "object" ||
    typeof (act as { sub?: unknown }).sub !== "string" ||
    typeof iat !== "number" ||
    typeof exp !== "number" ||
    // The gateway's own verifier refuses a longer one (`verify_couch_sync_jwt`).
    exp - iat > COUCH_SYNC_MAX_SECONDS
  ) {
    logWarn({
      source: "nyuchi-gateway",
      message: "Sync grant exchange answered an unexpected token; refused",
    });
    throw bad();
  }
  const database = `user_${sub}`;
  if (personIdFromDatabase(database) !== sub) throw bad();
  // The earlier of what the exchange said and what the token says, as a
  // duration from now (server clock), rounded down. Under a second is nothing.
  const endsAtMs = Math.min(grant.expiresAtMs, exp * 1000);
  const expiresInSeconds = Math.floor((endsAtMs - nowMs) / 1000);
  if (!Number.isFinite(endsAtMs) || !(expiresInSeconds >= 1)) throw bad();
  return { token: grant.token, expiresInSeconds, database };
}

export function createCouchSessionIssuer(deps: {
  exchanger: GrantSource;
  now?: () => number;
}): CouchSessionIssuer {
  const now = deps.now ?? Date.now;
  return {
    async issue({ userId, accessToken }) {
      // Nobody signed in is the only case that says the session has ended: the
      // page treats 401 as "signed out" and removes its local copy of the
      // person's settings, so it is never used for a doubt.
      if (!userId) throw new CouchIssueError(SIGNED_OUT_CODE);

      // A person IS signed in (the route has just seen them), so a missing or
      // ended access token is AuthKit's refresh failing for a moment (WorkOS
      // answering 5xx, say), not a session that ended: retry later.
      if (!accessToken) {
        logWarn({
          source: "nyuchi-gateway",
          message: "No access token for a signed-in person; not exchanged",
        });
        throw new CouchIssueError("couch_unavailable");
      }

      // A grant never outlives the access token it is made from. Below the
      // floor it would be due for renewal on arrival (see couch-session-timing),
      // so do not make one; the proxy refreshes the token on this route, so
      // this is a refresh that failed for a moment. Back off, do not loop.
      const subject = peekClaims(accessToken);
      if (subject && typeof subject.exp === "number") {
        const left = subject.exp * 1000 - now();
        if (left < COUCH_MIN_ACCESS_TOKEN_LIFE_MS) {
          logWarn({
            source: "nyuchi-gateway",
            message:
              "Access token ended or too short for a sync grant; not exchanged",
            meta: { secondsLeft: Math.max(0, Math.floor(left / 1000)) },
          });
          throw new CouchIssueError("couch_unavailable");
        }
      }

      let grant: PersonToken;
      try {
        grant = await deps.exchanger.getPersonToken(userId, accessToken);
      } catch (err) {
        throw mapExchangeError(err);
      }
      return toCredential(grant, now());
    },
  };
}

// ── Process-wide default ────────────────────────────────────────────────────

/**
 * One per process, so the in-flight dedupe and the short negative cache work
 * across requests: a tab that is refused is not exchanged for again on every
 * retry, and two tabs asking at once share one exchange.
 */
const defaultExchanger = createCouchGrantExchanger({
  config: () => gatewayConfig(),
  consoleClientId: () => consoleClientId(),
});

/**
 * The configured issuer, or null when the gateway origin, this app's key or
 * `WORKOS_CLIENT_ID` is missing or malformed (the route then answers 503
 * `couch_unavailable` and calls nothing).
 */
export function couchSessionIssuer(): CouchSessionIssuer | null {
  if (!gatewayConfig() || !consoleClientId()) return null;
  return createCouchSessionIssuer({ exchanger: defaultExchanger });
}
