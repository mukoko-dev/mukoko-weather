/**
 * The CouchDB sync-grant issuer (#396): the RFC 8693 exchange for `couch:user`
 * against a fake gateway that applies the rules of nyuchi-api (see
 * `test-support/fake-nyuchi-gateway.ts`), and against stubbed answers for the
 * ones the fake would never give. No network, no real clock, no real key.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("./observability", () => ({ logWarn: warn, logError: vi.fn() }));

import {
  COUCH_SYNC_AUDIENCE,
  COUCH_SYNC_MAX_SECONDS,
  COUCH_SYNC_SCOPE,
  CouchIssueError,
  couchSessionIssuer,
  createCouchGrantExchanger,
  createCouchSessionIssuer,
  isScheduledDeletion,
  type CouchSessionIssuer,
} from "./couch-session-issuer";
import {
  ACCESS_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT,
  peekClaims,
} from "./gateway-person-token";
import { COUCH_MIN_ACCESS_TOKEN_LIFE_MS } from "./couch-session-timing";
import {
  FakeNyuchiGateway,
  fakeJwt,
  workosAccessToken,
} from "./test-support/fake-nyuchi-gateway";
import type { GatewayConfig } from "./nyuchi-gateway";

const T0 = Date.parse("2026-11-03T09:00:00.000Z");
const KEY_ID = "nyk_weatherkey01";
const SECRET = "nys_supersecretvalue123";
const WORKOS_CLIENT = "client_mukoko_account";
const WORKOS_USER = "user_01HWORKOSUSER";
const PERSON = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

let clock = T0;
let gateway: FakeNyuchiGateway;

const accessToken = (lifeSeconds = 300, over: { clientId?: string } = {}) =>
  workosAccessToken({
    sub: WORKOS_USER,
    clientId: over.clientId ?? WORKOS_CLIENT,
    nowMs: clock,
    lifeSeconds,
  });

function newGateway(): FakeNyuchiGateway {
  return new FakeNyuchiGateway({
    consoleClientId: WORKOS_CLIENT,
    keys: {
      [KEY_ID]: {
        secret: SECRET,
        type: "internal",
        scopes: ["identity", "app-keys", "weather"],
      },
    },
    syncClientIds: [KEY_ID],
    persons: { [WORKOS_USER]: { id: PERSON } },
    now: () => clock,
  });
}

function issuerOver(config: GatewayConfig | null): CouchSessionIssuer {
  return createCouchSessionIssuer({
    exchanger: createCouchGrantExchanger({
      config: () => config,
      consoleClientId: () => WORKOS_CLIENT,
      now: () => clock,
    }),
    now: () => clock,
  });
}

const credentials = { clientId: KEY_ID, clientSecret: SECRET };

function make(): CouchSessionIssuer {
  return issuerOver({ transport: gateway.transport, credentials });
}

/** An issuer whose gateway answers whatever `reply` returns. */
function stubbed(reply: () => Response | Promise<Response>) {
  const transport = vi.fn(async () => reply());
  return {
    transport,
    issuer: issuerOver({
      transport: transport as unknown as GatewayConfig["transport"],
      credentials,
    }),
  };
}

/** A grant token as the gateway builds it, one claim changed. */
function grantToken(over: Record<string, unknown> = {}): string {
  const iat = Math.floor(clock / 1000);
  const claims: Record<string, unknown> = {
    sub: PERSON,
    aud: COUCH_SYNC_AUDIENCE,
    iss: "https://api.nyuchi.test",
    iat,
    exp: iat + 300,
    jti: "j1",
    scope: COUCH_SYNC_SCOPE,
    act: { sub: KEY_ID },
    ...over,
  };
  return fakeJwt(
    Object.fromEntries(
      Object.entries(claims).filter(([, v]) => v !== undefined),
    ),
  );
}

const exchangeAnswer = (token: string, over: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      access_token: token,
      issued_token_type: "urn:ietf:params:oauth:token-type:jwt",
      token_type: "Bearer",
      expires_in: 300,
      scope: COUCH_SYNC_SCOPE,
      ...over,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const refusal = (
  status: number,
  error: string,
  description = "x",
  headers: Record<string, string> = {},
) =>
  new Response(
    JSON.stringify({ detail: { error, error_description: description } }),
    { status, headers },
  );

async function failure(issuer: CouchSessionIssuer, at = accessToken()) {
  const err = await issuer.issue({ userId: WORKOS_USER, accessToken: at }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CouchIssueError);
  return err as CouchIssueError;
}

beforeEach(() => {
  clock = T0;
  warn.mockReset();
  gateway = newGateway();
  vi.unstubAllEnvs();
});

describe("the exchange it asks for", () => {
  it("is an RFC 8693 exchange for couch:user ALONE, as this app's own internal key", async () => {
    const at = accessToken();
    await make().issue({ userId: WORKOS_USER, accessToken: at });
    expect(gateway.requests).toHaveLength(1);
    const [req] = gateway.requests;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/auth/token");
    expect(req.form.grant_type).toBe(TOKEN_EXCHANGE_GRANT);
    expect(req.form.subject_token).toBe(at);
    expect(req.form.subject_token_type).toBe(ACCESS_TOKEN_TYPE);
    expect(req.form.scope).toBe("couch:user");
    expect(req.form.client_id).toBe(KEY_ID);
    expect(req.form.client_secret).toBe(SECRET);
    // The pair also as headers: the exchange is counted against the key.
    expect(req.headers["x-client-id"]).toBe(KEY_ID);
    expect(req.headers["x-client-secret"]).toBe(SECRET);
    expect(req.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(Object.keys(req.form).sort()).toEqual(
      [
        "client_id",
        "client_secret",
        "grant_type",
        "scope",
        "subject_token",
        "subject_token_type",
      ].sort(),
    );
  });

  it("needs no scope on the key beyond the identity every exchange needs", async () => {
    gateway = new FakeNyuchiGateway({
      consoleClientId: WORKOS_CLIENT,
      keys: {
        [KEY_ID]: { secret: SECRET, type: "internal", scopes: ["identity"] },
      },
      syncClientIds: [KEY_ID],
      persons: { [WORKOS_USER]: { id: PERSON } },
      now: () => clock,
    });
    const got = await make().issue({
      userId: WORKOS_USER,
      accessToken: accessToken(),
    });
    expect(got.database).toBe(`user_${PERSON}`);
  });

  it("never asks for the grant together with anything else", async () => {
    await make().issue({ userId: WORKOS_USER, accessToken: accessToken() });
    expect(gateway.requests[0].form.scope?.split(" ")).toEqual(["couch:user"]);
  });
});

describe("what it hands back", () => {
  it("the grant, the person's own database and when it ends", async () => {
    const got = await make().issue({
      userId: WORKOS_USER,
      accessToken: accessToken(),
    });
    const claims = peekClaims(got.token) as Record<string, unknown>;
    expect(claims).toMatchObject({
      sub: PERSON,
      aud: "couch-sync",
      scope: "couch:user",
      act: { sub: KEY_ID },
    });
    expect(got.database).toBe(`user_${PERSON}`);
    expect(got.expiresAtMs).toBe(T0 + 300_000);
    expect(got.expiresAtMs).toBe((claims.exp as number) * 1000);
  });

  it("is five minutes at most, however long the WorkOS token lives", async () => {
    const got = await make().issue({
      userId: WORKOS_USER,
      accessToken: accessToken(3600),
    });
    expect(got.expiresAtMs - T0).toBe(COUCH_SYNC_MAX_SECONDS * 1000);
  });

  it("never outlives the WorkOS access token it came from", async () => {
    const got = await make().issue({
      userId: WORKOS_USER,
      accessToken: accessToken(200),
    });
    expect(got.expiresAtMs - T0).toBe(200_000);
  });

  it("takes the earlier of the exchange's expires_in and the token's own exp", async () => {
    const early = stubbed(() =>
      exchangeAnswer(grantToken(), { expires_in: 100 }),
    );
    const a = await early.issuer.issue({
      userId: WORKOS_USER,
      accessToken: accessToken(),
    });
    expect(a.expiresAtMs).toBe(T0 + 100_000);

    clock = T0;
    const shortToken = stubbed(() =>
      exchangeAnswer(grantToken({ exp: Math.floor(T0 / 1000) + 60 }), {
        expires_in: 300,
      }),
    );
    const b = await shortToken.issuer.issue({
      userId: WORKOS_USER,
      accessToken: accessToken(),
    });
    expect(b.expiresAtMs).toBe(T0 + 60_000);
  });

  it("makes a new exchange for every request; only concurrent ones share", async () => {
    const issuer = make();
    const at = accessToken();
    const one = await issuer.issue({ userId: WORKOS_USER, accessToken: at });
    const two = await issuer.issue({ userId: WORKOS_USER, accessToken: at });
    expect(gateway.requests).toHaveLength(2);
    expect(two.token).not.toBe(one.token);

    gateway.requests.length = 0;
    const [x, y] = await Promise.all([
      issuer.issue({ userId: WORKOS_USER, accessToken: at }),
      issuer.issue({ userId: WORKOS_USER, accessToken: at }),
    ]);
    expect(gateway.requests).toHaveLength(1);
    expect(x.token).toBe(y.token);
  });

  it("a grant renewed a minute before it ends is a fresh one with a full life", async () => {
    const issuer = make();
    const first = await issuer.issue({
      userId: WORKOS_USER,
      accessToken: accessToken(),
    });
    clock = first.expiresAtMs - 60_000;
    // The proxy refreshed the WorkOS token for this route: a new 300 s one.
    const renewed = await issuer.issue({
      userId: WORKOS_USER,
      accessToken: accessToken(),
    });
    expect(renewed.expiresAtMs - clock).toBe(300_000);
    expect(renewed.token).not.toBe(first.token);
  });
});

describe("what the gateway can say, and what the page is told", () => {
  it("a session that ended is reauth_required", async () => {
    const { issuer } = stubbed(() =>
      refusal(400, "invalid_grant", "The WorkOS session has ended."),
    );
    expect(await failure(issuer)).toMatchObject({
      code: "reauth_required",
      status: 401,
    });
  });

  it("a scheduled deletion is account_pending_deletion, not 'sign in again'", async () => {
    gateway = new FakeNyuchiGateway({
      consoleClientId: WORKOS_CLIENT,
      keys: {
        [KEY_ID]: { secret: SECRET, type: "internal", scopes: ["identity"] },
      },
      syncClientIds: [KEY_ID],
      persons: { [WORKOS_USER]: { id: PERSON, deletionScheduled: true } },
      now: () => clock,
    });
    const issuer = make();
    expect(await failure(issuer)).toMatchObject({
      code: "account_pending_deletion",
      status: 403,
    });
    // Remembered for a moment: the gateway is not asked again at once.
    expect(await failure(issuer)).toMatchObject({
      code: "account_pending_deletion",
    });
    expect(gateway.requests).toHaveLength(1);
    // And the sentence is not in a log.
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/deletion/i);
  });

  it("past 30 exchanges a minute the gateway says slow down: rate_limited with its Retry-After", async () => {
    const { issuer, transport } = stubbed(() =>
      refusal(429, "slow_down", "Too many", { "retry-after": "45" }),
    );
    const at = accessToken();
    const err = await failure(issuer, at);
    expect(err).toMatchObject({
      code: "rate_limited",
      status: 429,
      retryAfterSeconds: 45,
    });
    // Not asked again while it says wait (at most 30 s of memory, less than
    // the 45 s it asked for), and the wait counts down.
    clock += 10_000;
    const again = await failure(issuer, at);
    expect(again).toMatchObject({ code: "rate_limited" });
    expect(again.retryAfterSeconds).toBe(20);
    expect(transport).toHaveBeenCalledTimes(1);
    clock += 21_000;
    await failure(issuer, at);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("the real fake gateway holds a person to 30 exchanges a minute", async () => {
    const issuer = make();
    const codes: string[] = [];
    for (let i = 0; i < 32; i++) {
      // A distinct token each time, so the negative memory does not answer.
      const at = workosAccessToken({
        sub: WORKOS_USER,
        clientId: WORKOS_CLIENT,
        nowMs: clock,
        lifeSeconds: 300 + i,
      });
      try {
        await issuer.issue({ userId: WORKOS_USER, accessToken: at });
        codes.push("ok");
      } catch (err) {
        codes.push((err as CouchIssueError).code);
      }
    }
    expect(codes.slice(0, 30)).toEqual(Array(30).fill("ok"));
    expect(codes[30]).toBe("rate_limited");
  });

  it.each([
    ["the key is not recognised", 401, "invalid_client"],
    ["the key may not exchange", 400, "unauthorized_client"],
    ["the client is not on the allow-list", 400, "invalid_scope"],
    ["the exchange is malformed", 400, "invalid_request"],
    ["no person is linked to the user", 404, "person_not_found"],
    ["the gateway is unavailable", 503, "temporarily_unavailable"],
    ["the gateway fails", 500, "internal_error"],
    ["a bad gateway answers", 502, "bad_gateway"],
  ])(
    "%s: couch_unavailable (the page stays local-only and backs off)",
    async (_why, status, error) => {
      const { issuer } = stubbed(() => refusal(status, error));
      expect(await failure(issuer)).toMatchObject({
        code: "couch_unavailable",
        status: 503,
      });
    },
  );

  it("a client that is not on the allow-list is refused by the (fake) gateway and logged without secrets", async () => {
    gateway.syncClientIds.clear();
    expect(await failure(make())).toMatchObject({ code: "couch_unavailable" });
    expect(gateway.requests[0]).toMatchObject({
      status: 400,
      error: "invalid_scope",
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("invalid_scope");
    expect(logged).not.toContain(SECRET);
  });

  it("no answer at all, or a timeout, is couch_unavailable", async () => {
    for (const thrown of [
      new TypeError("fetch failed"),
      new DOMException("aborted", "AbortError"),
    ]) {
      const issuer = issuerOver({
        transport: async () => {
          throw thrown;
        },
        credentials,
      });
      expect(
        await failure(issuer, accessToken(300 + Math.random())),
      ).toMatchObject({
        code: "couch_unavailable",
      });
    }
  });

  it("an answer that is not JSON is couch_unavailable", async () => {
    const { issuer } = stubbed(() => new Response("<html>", { status: 200 }));
    expect(await failure(issuer)).toMatchObject({ code: "couch_unavailable" });
  });

  it("a 200 for another scope than the one asked for is refused", async () => {
    const { issuer } = stubbed(() =>
      exchangeAnswer(grantToken(), { scope: "identity" }),
    );
    expect(await failure(issuer)).toMatchObject({ code: "couch_unavailable" });
    const wider = stubbed(() =>
      exchangeAnswer(grantToken(), { scope: "couch:user identity" }),
    );
    expect(await failure(wider.issuer, accessToken(301))).toMatchObject({
      code: "couch_unavailable",
    });
  });

  it("a person whose deletion is scheduled still gets no 200 with account_state either", async () => {
    const { issuer } = stubbed(() =>
      exchangeAnswer(grantToken(), { account_state: "pending_deletion" }),
    );
    expect(await failure(issuer)).toMatchObject({
      code: "account_pending_deletion",
    });
  });

  it("a failure is remembered briefly per person and token, then asked again", async () => {
    const { issuer, transport } = stubbed(() =>
      refusal(503, "temporarily_unavailable"),
    );
    const at = accessToken();
    await failure(issuer, at);
    await failure(issuer, at);
    expect(transport).toHaveBeenCalledTimes(1);
    clock += 11_000; // the memory of an outage is 10 s
    await failure(issuer, at);
    expect(transport).toHaveBeenCalledTimes(2);
  });
});

describe("a token that does not leave the server", () => {
  it("another WorkOS client's token is never sent to the gateway", async () => {
    const err = await failure(
      make(),
      accessToken(300, { clientId: "client_somebody_else" }),
    );
    expect(err).toMatchObject({ code: "couch_unavailable" });
    expect(gateway.requests).toEqual([]);
  });

  it("nothing is sent without a user and an access token, or for something that is no JWT", async () => {
    const issuer = make();
    for (const who of [
      { userId: "", accessToken: accessToken() },
      { userId: WORKOS_USER, accessToken: undefined },
      { userId: WORKOS_USER, accessToken: "" },
      { userId: WORKOS_USER, accessToken: "not-a-jwt" },
    ]) {
      const err = await issuer.issue(who).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ code: "reauth_required", status: 401 });
    }
    expect(gateway.requests).toEqual([]);
  });

  it("an access token that has ended is reauth_required, not sent", async () => {
    expect(await failure(make(), accessToken(-5))).toMatchObject({
      code: "reauth_required",
    });
    expect(gateway.requests).toEqual([]);
  });

  it("an access token with too little life is not exchanged: a grant made from it would be due on arrival", async () => {
    const floor = COUCH_MIN_ACCESS_TOKEN_LIFE_MS / 1000;
    for (const life of [1, 30, 60, floor - 1]) {
      expect(
        await failure(make(), accessToken(life)),
        `${life} s`,
      ).toMatchObject({
        code: "couch_unavailable",
        status: 503,
      });
    }
    expect(gateway.requests).toEqual([]);
    // It says so, with seconds and nothing else.
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("secondsLeft");
    // At the floor it is exchanged.
    const ok = await make().issue({
      userId: WORKOS_USER,
      accessToken: accessToken(floor),
    });
    expect(ok.expiresAtMs - T0).toBe(floor * 1000);
    expect(gateway.requests).toHaveLength(1);
  });

  it("the floor leaves a grant that outlives the page's renewal lead", () => {
    // couch-schedule.ts REFRESH_LEAD_MS is 60 s: the grant must be longer.
    expect(COUCH_MIN_ACCESS_TOKEN_LIFE_MS).toBeGreaterThan(60_000);
  });
});

describe("a token that is not the sync grant never reaches the page", () => {
  const iat = Math.floor(T0 / 1000);
  it.each([
    ["an ordinary sign-in audience", { aud: "authenticated" }],
    ["no audience", { aud: undefined }],
    ["another scope", { scope: "identity" }],
    ["a scope list", { scope: "couch:user identity" }],
    ["no scope", { scope: undefined }],
    ["no actor", { act: undefined }],
    ["an actor with no subject", { act: {} }],
    ["no subject", { sub: undefined }],
    ["an empty subject", { sub: "" }],
    ["a subject that cannot name a database", { sub: "Some/One" }],
    ["an upper-case subject", { sub: "ABC-DEF" }],
    ["a database-escaping subject", { sub: "x/../family_y" }],
    ["a lifetime longer than the cap", { exp: iat + 301 }],
    ["no lifetime", { iat: undefined }],
    ["an end that has passed", { iat: iat - 600, exp: iat - 10 }],
  ])("%s", async (_why, over) => {
    const bad = grantToken(over as Record<string, unknown>);
    const { issuer } = stubbed(() => exchangeAnswer(bad));
    expect(await failure(issuer)).toMatchObject({ code: "couch_unavailable" });
    // The refused token is not in any log line.
    expect(JSON.stringify(warn.mock.calls)).not.toContain(bad);
  });

  it("an answer whose access_token is not a JWT at all", async () => {
    const { issuer } = stubbed(() => exchangeAnswer("opaque-token-0123456789"));
    expect(await failure(issuer)).toMatchObject({ code: "couch_unavailable" });
  });
});

describe("nothing secret is ever logged or returned", () => {
  it("across every outcome, no key, WorkOS token or grant is in a log line or an error", async () => {
    const at = accessToken();
    const seen: string[] = [];
    const run = async (issuer: CouchSessionIssuer, token = at) => {
      try {
        const ok = await issuer.issue({
          userId: WORKOS_USER,
          accessToken: token,
        });
        seen.push(ok.token);
      } catch (err) {
        seen.push(JSON.stringify(err), String((err as Error).message));
      }
    };
    await run(make());
    await run(make(), accessToken(300, { clientId: "client_other" }));
    await run(make(), accessToken(30));
    gateway.syncClientIds.clear();
    await run(make(), accessToken(301));
    await run(
      stubbed(() => refusal(400, "invalid_grant", "deletion is scheduled"))
        .issuer,
      accessToken(302),
    );
    await run(
      stubbed(() => exchangeAnswer(grantToken({ aud: "x" }))).issuer,
      accessToken(303),
    );

    const everything = JSON.stringify(warn.mock.calls) + seen.join("\n");
    for (const secret of [
      SECRET,
      at,
      accessToken(300, { clientId: "client_other" }),
    ]) {
      expect(everything).not.toContain(secret);
    }
    // The only thing that may appear is the grant that WAS issued, in `seen`.
    const grant = seen[0];
    expect(JSON.stringify(warn.mock.calls)).not.toContain(grant);
  });
});

describe("the detail matched for a scheduled deletion", () => {
  it("is the sentence nyuchi-api sends (routers/auth.py l.514-517)", () => {
    expect(isScheduledDeletion("This person's deletion is scheduled.")).toBe(
      true,
    );
    expect(isScheduledDeletion("THIS PERSON'S DELETION IS SCHEDULED")).toBe(
      true,
    );
  });
  it("is nothing else: an ended session, an expiry, no text", () => {
    expect(isScheduledDeletion("The WorkOS session has ended.")).toBe(false);
    expect(isScheduledDeletion("The subject token has expired.")).toBe(false);
    expect(isScheduledDeletion("")).toBe(false);
    expect(isScheduledDeletion(null)).toBe(false);
  });
});

describe("couchSessionIssuer(): configured, or nothing", () => {
  const ok = {
    NYUCHI_API_URL: "https://api.nyuchi.com",
    NYUCHI_APP_KEYS_API_KEY: `${KEY_ID}.${SECRET}`,
    WORKOS_CLIENT_ID: WORKOS_CLIENT,
  };
  const stub = (over: Record<string, string> = {}) => {
    for (const [k, v] of Object.entries({ ...ok, ...over })) {
      vi.stubEnv(k, v);
    }
  };

  it("is an issuer when the origin, the key and the WorkOS client are set", () => {
    stub();
    expect(couchSessionIssuer()).not.toBeNull();
  });

  it.each([
    ["no gateway origin", { NYUCHI_API_URL: "" }],
    [
      "a plain-http gateway origin",
      { NYUCHI_API_URL: "http://api.nyuchi.com" },
    ],
    [
      "a gateway origin with a path",
      { NYUCHI_API_URL: "https://api.nyuchi.com/v1" },
    ],
    ["no key", { NYUCHI_APP_KEYS_API_KEY: "" }],
    ["a malformed key", { NYUCHI_APP_KEYS_API_KEY: "nyk_only" }],
    [
      "a key with the halves swapped",
      { NYUCHI_APP_KEYS_API_KEY: `${SECRET}.${KEY_ID}` },
    ],
    ["no WorkOS client", { WORKOS_CLIENT_ID: "" }],
    ["a blank WorkOS client", { WORKOS_CLIENT_ID: "   " }],
  ])(
    "is null with %s (the route answers 503 and calls nothing)",
    (_why, over) => {
      stub(over);
      expect(couchSessionIssuer()).toBeNull();
    },
  );
});
