/**
 * Server-only: trade the signed-in visitor's WorkOS access token for a
 * short-lived Nyuchi platform person token (nyuchi/api-gateway#307, design
 * comment 6227400096; owner decision: every user sends their own token).
 *
 *   POST {gateway}/v1/auth/token   (RFC 8693 token exchange)
 *     grant_type=urn:ietf:params:oauth:grant-type:token-exchange
 *     subject_token=<WorkOS access token from withAuth()>
 *     subject_token_type=urn:ietf:params:oauth:token-type:access_token
 *     scope=app-keys                       ← narrowed: nothing else
 *     client_id / client_secret            ← this app's internal key
 *
 * The gateway accepts only WorkOS tokens issued to the Console client
 * ("Mukoko Account"), so weather signs people in through that client. A
 * token from any other client is refused HERE, before it leaves the server:
 * it would be refused by the gateway anyway, and it must not be sent.
 *
 * Mirrors the gateway exactly (nyuchi/api-gateway staging @ 582f8b7):
 *   - issuing client: `gateway/lib/token_exchange.py` `_issuing_client`
 *     (l.303-313) — `client_id`, else `aud` (a string, or a one-element
 *     list). `iss` is never read for the client: it may name the
 *     environment's default application whichever app signed the person in
 *     (`accepted_issuers`, l.215-239).
 *   - scope: requested ∩ key scopes ∩ person scopes (`grant_scopes`,
 *     l.505-532); a pending-deletion person gets `identity` only, with
 *     `account_state` (`gateway/routers/auth.py` l.391-394, 442).
 *   - key pair also as X-Client-Id/X-Client-Secret (`auth.py`
 *     `_key_checked_by_middleware`, l.246-265).
 *   - errors on the wire: `{"detail": {"error", "error_description"}}`
 *     (`auth.py` `_oauth_error`, l.91-97); the refusal *reason* is only
 *     audited, never returned (`refuse`, l.288-290).
 *
 * The person token is cached in this process only, keyed by the WorkOS user
 * id plus a SHA-256 of the access token, for at most
 * min(expires_in, subject exp) − 30 s and never more than 5 minutes.
 * Concurrent requests for one key share one exchange. A failed exchange is
 * remembered briefly (`NEGATIVE_TTL_MS`) so a stuck user cannot re-exchange
 * on every request. The token never reaches the browser, a cookie, storage
 * or a log, and there is no fallback to a shared token: every failure fails
 * closed.
 */

import { createHash } from "node:crypto";
import {
  gatewayConfig,
  gatewayErrorCode,
  gatewayRequest,
  parseRetryAfter,
  type GatewayConfig,
} from "./nyuchi-gateway";
import { logWarn } from "./observability";

export const TOKEN_EXCHANGE_GRANT =
  "urn:ietf:params:oauth:grant-type:token-exchange";
export const ACCESS_TOKEN_TYPE =
  "urn:ietf:params:oauth:token-type:access_token";
/** The only scope weather ever asks for. */
export const REQUESTED_SCOPE = "app-keys";
export const SAFETY_MARGIN_MS = 30_000;
export const MAX_CACHE_MS = 5 * 60_000;
const MAX_ENTRIES = 1_000;
/**
 * How long a failed exchange is remembered per user + token, so a stuck
 * user cannot re-exchange on every request. Successes follow the TTL rules
 * above, never these.
 */
export const NEGATIVE_TTL_MS: Partial<Record<PersonTokenErrorCode, number>> = {
  reauth_required: 30_000,
  person_not_provisioned: 30_000,
  account_pending_deletion: 30_000,
  exchange_refused: 30_000,
  gateway_unconfigured: 30_000,
  gateway_unavailable: 10_000,
  rate_limited: 30_000,
};
/** How long a user's last "sign in again" is remembered (per user). */
export const REAUTH_MEMORY_MS = 60 * 60_000;

export type PersonTokenErrorCode =
  | "gateway_unconfigured" // env missing or malformed — 503
  | "wrong_workos_client" // signed in through a client other than the Console's — 503
  | "reauth_required" // WorkOS session ended / token refused — 401
  | "exchange_refused" // the same session refused again: likely config — 503
  | "person_not_provisioned" // no identity.persons record for this user — 409
  | "account_pending_deletion" // 403
  | "rate_limited" // 429
  | "gateway_unavailable"; // 5xx, network, timeout, bad answer — 503

const STATUS: Record<PersonTokenErrorCode, number> = {
  gateway_unconfigured: 503,
  wrong_workos_client: 503,
  reauth_required: 401,
  exchange_refused: 503,
  person_not_provisioned: 409,
  account_pending_deletion: 403,
  rate_limited: 429,
  gateway_unavailable: 503,
};

export class PersonTokenError extends Error {
  readonly status: number;
  constructor(
    readonly code: PersonTokenErrorCode,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = "PersonTokenError";
    this.status = STATUS[code];
  }
}

export interface PersonToken {
  /** The platform JWT. Server-side use only. */
  token: string;
  scope: string;
  expiresAtMs: number;
}

interface Entry {
  value: PersonToken;
  cacheUntilMs: number;
}

export interface ExchangerOptions {
  config: () => GatewayConfig | null;
  /** Expected issuing WorkOS client of subject tokens (the Console's). */
  consoleClientId: () => string;
  now?: () => number;
}

/** Unverified read of a JWT's payload — only to bound and pre-check. */
export function peekClaims(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const json = Buffer.from(part, "base64url").toString("utf8");
    const claims = JSON.parse(json) as unknown;
    return claims && typeof claims === "object"
      ? (claims as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The WorkOS client a token says it was issued to, exactly as the gateway
 * decides it (`_issuing_client`, token_exchange.py l.303-313): a non-empty
 * `client_id`; else a non-empty string `aud`; else a one-element `aud` list.
 * `iss` is deliberately not consulted (see the module header).
 */
export function issuingClient(claims: Record<string, unknown>): string | null {
  const clientId = claims.client_id;
  if (typeof clientId === "string" && clientId) return clientId;
  const aud = claims.aud;
  if (typeof aud === "string" && aud) return aud;
  if (Array.isArray(aud) && aud.length === 1 && typeof aud[0] === "string") {
    return aud[0];
  }
  return null;
}

function cacheKey(userId: string, accessToken: string): string {
  const digest = createHash("sha256").update(accessToken).digest("hex");
  return `${userId}:${digest}`;
}

export function createPersonTokenExchanger(options: ExchangerOptions) {
  const now = options.now ?? Date.now;
  const cache = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<PersonToken>>();
  const failures = new Map<
    string,
    { error: PersonTokenError; until: number }
  >();
  /** Per user: the last session told "sign in again", and when. */
  const reauthShown = new Map<
    string,
    { sid: string | null; atMs: number; untilMs: number }
  >();

  function boundedSet<V>(map: Map<string, V>, key: string, value: V): void {
    if (map.size >= MAX_ENTRIES) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, value);
  }

  function remember(key: string, error: PersonTokenError): void {
    let ttl = NEGATIVE_TTL_MS[error.code];
    if (!ttl) return;
    if (error.retryAfterSeconds) {
      ttl = Math.min(ttl, error.retryAfterSeconds * 1000);
    }
    boundedSet(failures, key, { error, until: now() + ttl });
  }

  /**
   * invalid_grant (the gateway returns it for every subject-token refusal,
   * the reason is not on the wire). Remembered per user:
   *   - the same session refused again: still "sign in again" (the person
   *     has not signed in again yet);
   *   - a session issued AFTER we last said "sign in again" (`iat` later)
   *     refused too: signing in again did not help, so the session is not
   *     the problem (most likely the Console client id configuration). An
   *     operator error, never a sign-in loop.
   * Logged without any token.
   */
  function invalidGrant(
    userId: string,
    sid: string | null,
    iatMs: number | null,
  ): PersonTokenError {
    const t = now();
    const last = reauthShown.get(userId);
    const live = last !== undefined && last.untilMs > t;
    const signedInAgain =
      live && last.sid !== sid && iatMs !== null && iatMs > last.atMs;
    logWarn({
      source: "nyuchi-gateway",
      message: signedInAgain
        ? "Token exchange refused a session issued after the last sign-in prompt; check the Console client id configuration"
        : "Token exchange refused the WorkOS session (invalid_grant)",
      meta: {
        consoleClientId: options.consoleClientId(),
        repeat: signedInAgain,
      },
    });
    if (signedInAgain) return new PersonTokenError("exchange_refused");
    if (!(live && last.sid === sid)) {
      reauthShown.delete(userId);
      boundedSet(reauthShown, userId, {
        sid,
        atMs: t,
        untilMs: t + REAUTH_MEMORY_MS,
      });
    }
    return new PersonTokenError("reauth_required");
  }

  function prune(): void {
    const t = now();
    for (const [k, e] of cache) if (e.cacheUntilMs <= t) cache.delete(k);
    while (cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  async function exchange(
    config: GatewayConfig,
    accessToken: string,
    subjectExpMs: number | null,
    userId: string,
    sid: string | null,
    iatMs: number | null,
  ): Promise<{ value: PersonToken; cacheUntilMs: number }> {
    const body = new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: accessToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
      scope: REQUESTED_SCOPE,
      client_id: config.credentials.clientId,
      client_secret: config.credentials.clientSecret,
    });
    let response: Response;
    try {
      response = await config.transport(
        gatewayRequest("/v1/auth/token", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
            // The same pair as the form, so the gateway's middleware
            // authenticates the key and counts the call against the key's
            // own limit, not the shared Vercel egress IP.
            "x-client-id": config.credentials.clientId,
            "x-client-secret": config.credentials.clientSecret,
          },
          body: body.toString(),
        }),
      );
    } catch {
      throw new PersonTokenError("gateway_unavailable");
    }

    if (response.status !== 200) {
      const code = await gatewayErrorCode(response);
      if (response.status === 400 && code === "invalid_grant") {
        throw invalidGrant(userId, sid, iatMs);
      }
      throw mapExchangeFailure(response, code);
    }

    let data: Record<string, unknown>;
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new PersonTokenError("gateway_unavailable");
    }
    // A pending-deletion person is granted `identity` only, with
    // `account_state` (auth.py l.391-394, 442), so this comes before the scope
    // check: it is that person's state, not a bad answer.
    if (data.account_state) {
      throw new PersonTokenError("account_pending_deletion");
    }
    const token = data.access_token;
    const scope = typeof data.scope === "string" ? data.scope.trim() : "";
    const expiresIn = Number(data.expires_in);
    // Exactly the narrowed scope: a wider token is not used.
    if (
      typeof token !== "string" ||
      !token ||
      scope !== REQUESTED_SCOPE ||
      !Number.isFinite(expiresIn) ||
      expiresIn <= 0
    ) {
      logWarn({
        source: "nyuchi-gateway",
        message: "Token exchange answered an unusable token; refused",
      });
      throw new PersonTokenError("gateway_unavailable");
    }
    const t = now();
    const expiresAtMs = Math.min(
      t + expiresIn * 1000,
      subjectExpMs ?? Number.POSITIVE_INFINITY,
    );
    const cacheUntilMs = Math.min(
      expiresAtMs - SAFETY_MARGIN_MS,
      t + MAX_CACHE_MS,
    );
    return { value: { token, scope, expiresAtMs }, cacheUntilMs };
  }

  /**
   * The person token for this signed-in user. Throws `PersonTokenError`;
   * never returns a shared or fallback credential.
   */
  async function getPersonToken(
    userId: string,
    accessToken: string | undefined,
  ): Promise<PersonToken> {
    if (!userId || !accessToken) throw new PersonTokenError("reauth_required");

    const claims = peekClaims(accessToken);
    if (!claims) throw new PersonTokenError("reauth_required");
    const expected = options.consoleClientId();
    if (!expected) throw new PersonTokenError("gateway_unconfigured");
    if (issuingClient(claims) !== expected) {
      // Never forward another client's token to the gateway.
      logWarn({
        source: "nyuchi-gateway",
        message:
          "Signed-in session is not from the Console WorkOS client; exchange not attempted",
      });
      throw new PersonTokenError("wrong_workos_client");
    }
    const exp = typeof claims.exp === "number" ? claims.exp * 1000 : null;
    if (exp !== null && exp - SAFETY_MARGIN_MS <= now()) {
      throw new PersonTokenError("reauth_required");
    }

    const config = options.config();
    if (!config) throw new PersonTokenError("gateway_unconfigured");

    const key = cacheKey(userId, accessToken);
    const hit = cache.get(key);
    if (hit && hit.cacheUntilMs > now()) return hit.value;
    if (hit) cache.delete(key);

    const failed = failures.get(key);
    if (failed && failed.until > now()) {
      const left = Math.max(1, Math.ceil((failed.until - now()) / 1000));
      throw new PersonTokenError(
        failed.error.code,
        failed.error.code === "rate_limited" ? left : undefined,
      );
    }
    if (failed) failures.delete(key);

    const pending = inFlight.get(key);
    if (pending) return pending;

    const sid = typeof claims.sid === "string" ? claims.sid : null;
    const iatMs = typeof claims.iat === "number" ? claims.iat * 1000 : null;
    const promise = exchange(config, accessToken, exp, userId, sid, iatMs)
      .then(({ value, cacheUntilMs }) => {
        if (cacheUntilMs > now()) {
          prune();
          cache.set(key, { value, cacheUntilMs });
        }
        return value;
      })
      .catch((err: unknown) => {
        if (err instanceof PersonTokenError) remember(key, err);
        throw err;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  }

  /** Drop a user's cached tokens (e.g. after the gateway answered 401). */
  function forget(userId: string): void {
    for (const k of cache.keys()) {
      if (k.startsWith(`${userId}:`)) cache.delete(k);
    }
    for (const k of failures.keys()) {
      if (k.startsWith(`${userId}:`)) failures.delete(k);
    }
  }

  return { getPersonToken, forget, cacheSize: () => cache.size };
}

function mapExchangeFailure(
  response: Response,
  code: string | null,
): PersonTokenError {
  const status = response.status;
  if (status === 429) {
    return new PersonTokenError(
      "rate_limited",
      parseRetryAfter(response.headers.get("retry-after")),
    );
  }
  if (status === 404 && code === "person_not_found") {
    // `/v1/identity/persons/ensure` stays Console-backend-only (design
    // decision 3, open): weather does not provision people at the gateway.
    // The person is mirrored by our own /callback; signing in again retries.
    return new PersonTokenError("person_not_provisioned");
  }
  if (status >= 400 && status < 500) {
    // 401 invalid_client (auth.py l.298-302), 400 unauthorized_client
    // (l.306-317), invalid_request (l.319-337), invalid_scope
    // (token_exchange.py l.525-531), 422 a malformed form: our key or
    // request is wrong or under-scoped. Operator problem; fail closed.
    // 503 temporarily_unavailable (token_exchange.py l.148-149) and any 5xx
    // fall through to gateway_unavailable.
    logWarn({
      source: "nyuchi-gateway",
      message: "Token exchange refused this app's key",
      meta: { status, error: code },
    });
    return new PersonTokenError("gateway_unconfigured");
  }
  return new PersonTokenError("gateway_unavailable");
}

// ── Process-wide default ────────────────────────────────────────────────────

/**
 * The WorkOS client every Mukoko app signs in through ("Mukoko Account"):
 * this app's own `WORKOS_CLIENT_ID`. One account, one client, so there is no
 * second variable and no built-in default; "" when unset, and the exchange
 * then fails closed (`gateway_unconfigured`).
 */
export function consoleClientId(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.WORKOS_CLIENT_ID?.trim() ?? "";
}

const defaultExchanger = createPersonTokenExchanger({
  config: () => gatewayConfig(),
  consoleClientId: () => consoleClientId(),
});

export const getPersonToken = defaultExchanger.getPersonToken;
export const forgetPersonTokens = defaultExchanger.forget;
