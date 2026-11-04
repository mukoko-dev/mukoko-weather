/**
 * TEST SUPPORT, not shipped: the Nyuchi API gateway's token exchange for the
 * CouchDB sync grant, as far as the rules this site depends on go. No network:
 * `transport` is a `GatewayTransport` and `fetch` a `fetch`-shaped entry.
 *
 * Every rule is ported from nyuchi-api `staging` (read 2026-11-03, after
 * v0.53.0) and names its source, so a reader can check the port against the
 * gateway rather than against this file:
 *
 *   - the key must be valid, `internal`, and hold `identity`
 *     (`routers/auth.py` `_exchange_token` l.299-323);
 *   - `subject_token_type` and `requested_token_type` (l.325-346);
 *   - the sync request: scope exactly `couch:user`, from a client on
 *     `COUCH_SYNC_CLIENT_IDS` (`lib/token_exchange.py` `check_sync_request`
 *     l.614-632, called at `auth.py` l.348-354);
 *   - the subject token: not expired, issued to the gateway's
 *     `WORKOS_CONSOLE_CLIENT_ID` (`client_id` claim, else `aud`; never `iss`:
 *     `verify_subject_token` l.369-441, `_issuing_client` l.313-322). The
 *     signature is not checked here: the tests build the token;
 *   - 30 exchanges a minute per person, before the lookups (`auth.py` l.499);
 *   - the person must exist (404 `person_not_found`) and a scheduled deletion
 *     is 400 `invalid_grant` "This person's deletion is scheduled."
 *     (`_issue_sync_grant` l.514-517);
 *   - the grant: `aud` `couch-sync`, `scope` `couch:user`, `act.sub` the
 *     exchanging client, at most 300 s and never past the subject token
 *     (`lib/jwt.py` `create_couch_sync_token` l.373-388, `sync_lifetime`
 *     l.635-637);
 *   - using it: `verify_couch_sync_jwt` (l.391-414) plus the allow-list at
 *     every use (`routers/couch.py` `get_couch_caller` l.90-91), so taking a
 *     client off the list stops its grants;
 *   - the error body is `{"detail": {"error", "error_description"}}`
 *     (`_oauth_error` l.97-103).
 *
 * It is NOT the gateway: no signatures, no WorkOS session check, no audit log.
 * Nothing here proves behaviour of the live service.
 */

import type { GatewayTransport } from "../nyuchi-gateway";

export const GRANT_SCOPE = "couch:user";
export const GRANT_AUDIENCE = "couch-sync";
export const GRANT_MAX_SECONDS = 300;
const EXCHANGE_MAX_SECONDS = 15 * 60; // TOKEN_EXCHANGE_MAX_SECONDS
const PERSON_EXCHANGES_PER_MINUTE = 30; // PERSON_EXCHANGE_LIMIT

/** A JWT-shaped string with a readable payload and no signature to check. */
export function fakeJwt(
  claims: Record<string, unknown>,
  signature = "sig",
): string {
  const enc = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256", typ: "JWT" })}.${enc(claims)}.${signature}`;
}

/** A WorkOS access token as the site's session holds it. */
export function workosAccessToken(options: {
  sub: string;
  clientId: string;
  nowMs?: number;
  /** Seconds of life from `nowMs`. Default 300 (AuthKit's default lifetime). */
  lifeSeconds?: number;
  sid?: string;
}): string {
  const now = Math.floor((options.nowMs ?? Date.now()) / 1000);
  return fakeJwt({
    sub: options.sub,
    client_id: options.clientId,
    sid: options.sid ?? "session_1",
    iat: now,
    exp: now + (options.lifeSeconds ?? 300),
  });
}

export interface FakeGatewayKey {
  secret: string;
  type: "internal" | "external";
  scopes: string[];
}

export interface FakeGatewayPerson {
  /** The platform person id (`sub` of the grant). */
  id: string;
  deletionScheduled?: boolean;
}

export interface FakeGatewayOptions {
  /** nyuchi-api `WORKOS_CONSOLE_CLIENT_ID`. */
  consoleClientId: string;
  /** Registered keys by client id (`nyk_...`). */
  keys: Record<string, FakeGatewayKey>;
  /** `COUCH_SYNC_CLIENT_IDS`. */
  syncClientIds: string[];
  /** Persons by WorkOS user id. */
  persons: Record<string, FakeGatewayPerson>;
  now?: () => number;
}

export interface RecordedExchange {
  path: string;
  method: string;
  /** The form fields. Test secrets only: never real ones. */
  form: Record<string, string>;
  headers: Record<string, string>;
  status: number;
  /** The error code the gateway answered, if it was an error. */
  error?: string;
}

export interface GrantClaims {
  sub: string;
  aud: string;
  scope: string;
  act: { sub: string };
  iat: number;
  exp: number;
  jti: string;
}

function oauthError(
  status: number,
  error: string,
  description: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({ detail: { error, error_description: description } }),
    {
      status,
      headers: { "content-type": "application/json", ...headers },
    },
  );
}

export class FakeNyuchiGateway {
  readonly requests: RecordedExchange[] = [];
  /** The live allow-list: change it to revoke a client. */
  syncClientIds: Set<string>;
  /** Make the next N exchanges fail with this status (0 = network error). */
  failNext: { status: number; count: number; retryAfter?: string } | null =
    null;
  private readonly issued = new Set<string>();
  private readonly exchangeLog = new Map<string, number[]>();
  private jti = 0;

  constructor(private readonly options: FakeGatewayOptions) {
    this.syncClientIds = new Set(options.syncClientIds);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** The gateway as the site's server reaches it. */
  transport: GatewayTransport = async (request) => {
    const url = new URL(request.url);
    const text = request.method === "GET" ? "" : await request.text();
    const form = Object.fromEntries(new URLSearchParams(text));
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const respond = (response: Response, error?: string): Response => {
      this.requests.push({
        path: url.pathname,
        method: request.method,
        form,
        headers,
        status: response.status,
        ...(error ? { error } : {}),
      });
      return response;
    };

    if (this.failNext && this.failNext.count > 0) {
      this.failNext.count -= 1;
      const { status, retryAfter } = this.failNext;
      if (status === 0) {
        this.requests.push({
          path: url.pathname,
          method: request.method,
          form,
          headers,
          status: 0,
        });
        throw new TypeError("network error");
      }
      return respond(
        oauthError(
          status,
          "temporarily_unavailable",
          "injected",
          retryAfter ? { "retry-after": retryAfter } : {},
        ),
        "temporarily_unavailable",
      );
    }

    if (url.pathname !== "/v1/auth/token" || request.method !== "POST") {
      return respond(new Response("{}", { status: 404 }));
    }
    return this.exchange(form, respond);
  };

  /** `fetch`-shaped entry, for `vi.stubGlobal("fetch", ...)`. */
  fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request =
      input instanceof Request ? input : new Request(String(input), init);
    return this.transport(request);
  };

  private exchange(
    form: Record<string, string>,
    respond: (r: Response, error?: string) => Response,
  ): Response {
    const refuse = (
      status: number,
      error: string,
      description: string,
      headers?: Record<string, string>,
    ) => respond(oauthError(status, error, description, headers), error);

    // Key: valid, internal, holding `identity` (auth.py l.299-323).
    const key = this.options.keys[form.client_id ?? ""];
    if (!key || key.secret !== form.client_secret) {
      return refuse(401, "invalid_client", "Invalid client credentials");
    }
    if (key.type !== "internal" || !key.scopes.includes("identity")) {
      return refuse(
        400,
        "unauthorized_client",
        "Only an internal key with the 'identity' scope may exchange tokens.",
      );
    }
    if (
      form.grant_type !== "urn:ietf:params:oauth:grant-type:token-exchange" ||
      !form.subject_token ||
      form.subject_token_type !==
        "urn:ietf:params:oauth:token-type:access_token"
    ) {
      return refuse(400, "invalid_request", "Send a token exchange.");
    }

    // The sync request: scope alone, client on the allow-list (l.614-632).
    if ((form.scope ?? "").split(/\s+/).includes(GRANT_SCOPE)) {
      if (
        (form.scope ?? "").split(/\s+/).filter(Boolean).join(" ") !==
        GRANT_SCOPE
      ) {
        return refuse(
          400,
          "invalid_scope",
          `${GRANT_SCOPE} is a separate grant: request it alone.`,
        );
      }
      if (!this.syncClientIds.has(form.client_id)) {
        return refuse(
          400,
          "invalid_scope",
          `This client may not be granted ${GRANT_SCOPE}.`,
        );
      }
    } else {
      return refuse(400, "invalid_scope", "Not the sync grant (not modelled).");
    }

    // The subject token (l.369-441).
    let claims: Record<string, unknown>;
    try {
      claims = JSON.parse(
        Buffer.from(
          form.subject_token.split(".")[1] ?? "",
          "base64url",
        ).toString("utf8"),
      ) as Record<string, unknown>;
    } catch {
      return refuse(400, "invalid_grant", "The subject token is not a JWT.");
    }
    const nowS = this.now() / 1000;
    if (typeof claims.exp !== "number" || claims.exp <= nowS) {
      return refuse(400, "invalid_grant", "The subject token has expired.");
    }
    const issuing =
      typeof claims.client_id === "string" && claims.client_id
        ? claims.client_id
        : typeof claims.aud === "string"
          ? claims.aud
          : null;
    if (issuing !== this.options.consoleClientId) {
      return refuse(
        400,
        "invalid_grant",
        "The subject token was not issued to the Nyuchi Console.",
      );
    }
    const workosUserId = claims.sub;
    if (typeof workosUserId !== "string" || !workosUserId) {
      return refuse(400, "invalid_grant", "The subject token names no user.");
    }

    // Per person, before the lookups (auth.py l.499).
    const minuteAgo = this.now() - 60_000;
    const recent = (this.exchangeLog.get(workosUserId) ?? []).filter(
      (t) => t > minuteAgo,
    );
    if (recent.length >= PERSON_EXCHANGES_PER_MINUTE) {
      this.exchangeLog.set(workosUserId, recent);
      return refuse(
        429,
        "slow_down",
        "Too many token exchanges for this person; retry in a minute.",
        { "retry-after": "60" },
      );
    }
    recent.push(this.now());
    this.exchangeLog.set(workosUserId, recent);

    const person = this.options.persons[workosUserId];
    if (!person) {
      return refuse(
        404,
        "person_not_found",
        "No person is linked to this WorkOS user.",
      );
    }
    if (person.deletionScheduled) {
      return refuse(
        400,
        "invalid_grant",
        "This person's deletion is scheduled.",
      );
    }

    // Lifetime: capped, never past the subject token (l.635-637, 640-648).
    const remaining = Math.floor(claims.exp - nowS);
    const seconds = Math.min(
      GRANT_MAX_SECONDS,
      Math.min(EXCHANGE_MAX_SECONDS, remaining),
    );
    if (seconds < 1) {
      return refuse(400, "invalid_grant", "The subject token has expired.");
    }
    const iat = Math.floor(this.now() / 1000);
    this.jti += 1;
    const jti = `grant-${this.jti}`;
    this.issued.add(jti);
    const token = fakeJwt(
      {
        sub: person.id,
        aud: GRANT_AUDIENCE,
        iss: "https://api.nyuchi.test",
        iat,
        exp: iat + seconds,
        jti,
        scope: GRANT_SCOPE,
        act: { sub: form.client_id },
      },
      jti,
    );
    return respond(
      new Response(
        JSON.stringify({
          access_token: token,
          issued_token_type: "urn:ietf:params:oauth:token-type:jwt",
          token_type: "Bearer",
          expires_in: seconds,
          scope: GRANT_SCOPE,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }

  /**
   * Using a grant (`verify_couch_sync_jwt` + `get_couch_caller`): the claims
   * when the bearer is a grant this gateway issued, still in date, still from
   * an allow-listed client; else why it is refused (401 not a valid grant,
   * 403 its client was taken off the list).
   */
  authorize(
    authorization: string | null,
  ): { ok: true; claims: GrantClaims } | { ok: false; status: 401 | 403 } {
    if (!authorization?.startsWith("Bearer "))
      return { ok: false, status: 401 };
    const token = authorization.slice("Bearer ".length);
    let claims: Partial<GrantClaims>;
    try {
      claims = JSON.parse(
        Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
      ) as Partial<GrantClaims>;
    } catch {
      return { ok: false, status: 401 };
    }
    const nowS = this.now() / 1000;
    if (
      typeof claims.jti !== "string" ||
      !this.issued.has(claims.jti) ||
      claims.aud !== GRANT_AUDIENCE ||
      claims.scope !== GRANT_SCOPE ||
      typeof claims.sub !== "string" ||
      typeof claims.act?.sub !== "string" ||
      typeof claims.exp !== "number" ||
      typeof claims.iat !== "number" ||
      claims.exp <= nowS ||
      claims.exp - claims.iat > GRANT_MAX_SECONDS
    ) {
      return { ok: false, status: 401 };
    }
    if (!this.syncClientIds.has(claims.act.sub))
      return { ok: false, status: 403 };
    return { ok: true, claims: claims as GrantClaims };
  }
}
