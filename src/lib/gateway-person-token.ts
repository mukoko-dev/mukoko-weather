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
 * The person token is cached in this process only, keyed by the WorkOS user
 * id plus a SHA-256 of the access token, for at most
 * min(expires_in, subject exp) − 30 s and never more than 5 minutes.
 * Concurrent requests for one key share one exchange. Errors are never
 * cached. The token never reaches the browser, a cookie, storage or a log,
 * and there is no fallback to a shared token: every failure fails closed.
 */

import { createHash } from "node:crypto";
import {
  gatewayConfig,
  gatewayErrorCode,
  gatewayRequest,
  type GatewayConfig,
} from "./nyuchi-gateway";
import { logWarn } from "./observability";

export const TOKEN_EXCHANGE_GRANT =
  "urn:ietf:params:oauth:grant-type:token-exchange";
export const ACCESS_TOKEN_TYPE =
  "urn:ietf:params:oauth:token-type:access_token";
/** The only scope weather ever asks for. */
export const REQUESTED_SCOPE = "app-keys";
/** "Mukoko Account" — the Console's WorkOS client, the only one accepted. */
export const DEFAULT_CONSOLE_CLIENT_ID = "client_01KV2G518HGXVMTAFQDKSVNXCW";
export const SAFETY_MARGIN_MS = 30_000;
export const MAX_CACHE_MS = 5 * 60_000;
const MAX_ENTRIES = 1_000;

export type PersonTokenErrorCode =
  | "gateway_unconfigured" // env missing or malformed — 503
  | "wrong_workos_client" // signed in through a client other than the Console's — 503
  | "reauth_required" // WorkOS session ended / token refused — 401
  | "person_not_provisioned" // no identity.persons record for this user — 409
  | "account_pending_deletion" // 403
  | "rate_limited" // 429
  | "gateway_unavailable"; // 5xx, network, timeout, bad answer — 503

const STATUS: Record<PersonTokenErrorCode, number> = {
  gateway_unconfigured: 503,
  wrong_workos_client: 503,
  reauth_required: 401,
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

/** The WorkOS client a token says it was issued to, if any. */
export function issuingClient(claims: Record<string, unknown>): string | null {
  if (typeof claims.client_id === "string") return claims.client_id;
  if (typeof claims.aud === "string") return claims.aud;
  if (Array.isArray(claims.aud) && typeof claims.aud[0] === "string") {
    return claims.aud.length === 1 ? claims.aud[0] : null;
  }
  return null;
}

function cacheKey(userId: string, accessToken: string): string {
  const digest = createHash("sha256").update(accessToken).digest("hex");
  return `${userId}:${digest}`;
}

function retryAfter(response: Response): number | undefined {
  const raw = Number(response.headers.get("retry-after"));
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 3600) : undefined;
}

export function createPersonTokenExchanger(options: ExchangerOptions) {
  const now = options.now ?? Date.now;
  const cache = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<PersonToken>>();

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
          },
          body: body.toString(),
        }),
      );
    } catch {
      throw new PersonTokenError("gateway_unavailable");
    }

    if (response.status !== 200) {
      const code = await gatewayErrorCode(response);
      throw mapExchangeFailure(response, code);
    }

    let data: Record<string, unknown>;
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new PersonTokenError("gateway_unavailable");
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
    if (data.account_state) {
      throw new PersonTokenError("account_pending_deletion");
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

    const pending = inFlight.get(key);
    if (pending) return pending;

    const promise = exchange(config, accessToken, exp)
      .then(({ value, cacheUntilMs }) => {
        if (cacheUntilMs > now()) {
          prune();
          cache.set(key, { value, cacheUntilMs });
        }
        return value;
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
  }

  return { getPersonToken, forget, cacheSize: () => cache.size };
}

function mapExchangeFailure(
  response: Response,
  code: string | null,
): PersonTokenError {
  const status = response.status;
  if (status === 429) {
    return new PersonTokenError("rate_limited", retryAfter(response));
  }
  if (status === 404 && code === "person_not_found") {
    // `/v1/identity/persons/ensure` stays Console-backend-only (design
    // decision 3, open): weather does not provision people at the gateway.
    // The person is mirrored by our own /callback; signing in again retries.
    return new PersonTokenError("person_not_provisioned");
  }
  if (status === 400 && code === "client_not_allowed") {
    return new PersonTokenError("wrong_workos_client");
  }
  if (status === 400 && code === "invalid_grant") {
    // Expired, signed-out or revoked WorkOS session (the issuing client was
    // already checked locally).
    return new PersonTokenError("reauth_required");
  }
  if (status >= 400 && status < 500) {
    // invalid_client, unauthorized_client, invalid_scope: our key is wrong
    // or under-scoped. Operator problem; fail closed.
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

export function consoleClientId(
  env: Record<string, string | undefined> = process.env,
): string {
  return (
    env.NYUCHI_CONSOLE_WORKOS_CLIENT_ID?.trim() || DEFAULT_CONSOLE_CLIENT_ID
  );
}

const defaultExchanger = createPersonTokenExchanger({
  config: () => gatewayConfig(),
  consoleClientId: () => consoleClientId(),
});

export const getPersonToken = defaultExchanger.getPersonToken;
export const forgetPersonTokens = defaultExchanger.forget;
