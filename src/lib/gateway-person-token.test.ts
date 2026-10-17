/**
 * Person-token exchange (nyuchi/api-gateway#307). No network and no real
 * clock: the transport is a stub and `now` is injected.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("./observability", () => ({ logWarn: warn, logError: vi.fn() }));

import {
  createPersonTokenExchanger,
  consoleClientId,
  DEFAULT_CONSOLE_CLIENT_ID,
  issuingClient,
  MAX_CACHE_MS,
  peekClaims,
  PersonTokenError,
  REQUESTED_SCOPE,
  SAFETY_MARGIN_MS,
  TOKEN_EXCHANGE_GRANT,
  ACCESS_TOKEN_TYPE,
} from "./gateway-person-token";
import type { GatewayConfig } from "./nyuchi-gateway";

const CONSOLE = "client_console";
const T0 = 1_800_000_000_000; // fixed instant, ms
const SECRET = "nys_supersecretvalue123";
const PERSON_JWT = "eyJhbGciOiJSUzI1NiJ9.person.token-signature";

function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc(claims)}.sig`;
}

const subject = (extra: Record<string, unknown> = {}) =>
  jwt({
    sub: "user_1",
    client_id: CONSOLE,
    exp: T0 / 1000 + 300,
    sid: "s1",
    ...extra,
  });

function ok(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
const granted = (expires_in = 300) =>
  ok({
    access_token: PERSON_JWT,
    issued_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_type: "Bearer",
    expires_in,
    scope: "app-keys",
  });
function fail(status: number, error: string, headers = {}): Response {
  return new Response(
    JSON.stringify({ detail: { error, error_description: "x" } }),
    { status, headers },
  );
}

let clock = T0;
let transport: ReturnType<typeof vi.fn>;
function make(config: GatewayConfig | null = null) {
  const cfg: GatewayConfig = config ?? {
    transport: transport as unknown as GatewayConfig["transport"],
    credentials: { clientId: "nyk_weatherkey01", clientSecret: SECRET },
  };
  return createPersonTokenExchanger({
    config: () => cfg,
    consoleClientId: () => CONSOLE,
    now: () => clock,
  });
}

beforeEach(() => {
  clock = T0;
  warn.mockReset();
  transport = vi.fn(async () => granted());
});

describe("exchange request shape", () => {
  it("posts an RFC 8693 token exchange narrowed to app-keys", async () => {
    const ex = make();
    const token = subject();
    await ex.getPersonToken("user_1", token);
    expect(transport).toHaveBeenCalledTimes(1);
    const req = transport.mock.calls[0][0] as Request;
    expect(new URL(req.url).pathname).toBe("/v1/auth/token");
    expect(req.method).toBe("POST");
    expect(req.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    const form = new URLSearchParams(await req.text());
    expect(form.get("grant_type")).toBe(TOKEN_EXCHANGE_GRANT);
    expect(form.get("subject_token")).toBe(token);
    expect(form.get("subject_token_type")).toBe(ACCESS_TOKEN_TYPE);
    expect(form.get("scope")).toBe("app-keys");
    expect(REQUESTED_SCOPE).toBe("app-keys");
    expect(form.get("client_id")).toBe("nyk_weatherkey01");
    expect(form.get("client_secret")).toBe(SECRET);
    // No other grant parameters (no actor token, no audience widening).
    expect([...form.keys()].sort()).toEqual(
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

  it("returns the person token server-side", async () => {
    const got = await make().getPersonToken("user_1", subject());
    expect(got.token).toBe(PERSON_JWT);
    expect(got.scope).toBe("app-keys");
  });
});

describe("Console client only", () => {
  it("never sends a token issued to another WorkOS client", async () => {
    const ex = make();
    await expect(
      ex.getPersonToken("user_1", subject({ client_id: "client_weather" })),
    ).rejects.toMatchObject({ code: "wrong_workos_client", status: 503 });
    expect(transport).not.toHaveBeenCalled();
  });

  it("never sends a token that names no issuing client", async () => {
    const ex = make();
    await expect(
      ex.getPersonToken("user_1", subject({ client_id: undefined })),
    ).rejects.toMatchObject({ code: "wrong_workos_client" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("accepts the Console client from aud when there is no client_id", () => {
    expect(issuingClient({ aud: CONSOLE })).toBe(CONSOLE);
    expect(issuingClient({ aud: [CONSOLE] })).toBe(CONSOLE);
    expect(issuingClient({ aud: [CONSOLE, "other"] })).toBeNull();
  });

  it("refuses a missing or unparseable access token without a call", async () => {
    const ex = make();
    await expect(ex.getPersonToken("user_1", undefined)).rejects.toMatchObject({
      code: "reauth_required",
      status: 401,
    });
    await expect(ex.getPersonToken("user_1", "garbage")).rejects.toMatchObject({
      code: "reauth_required",
    });
    expect(peekClaims("a.b.c")).toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });

  it("defaults to the Mukoko Account client and allows an env override", () => {
    expect(DEFAULT_CONSOLE_CLIENT_ID).toBe("client_01KV2G518HGXVMTAFQDKSVNXCW");
    expect(consoleClientId({})).toBe(DEFAULT_CONSOLE_CLIENT_ID);
    expect(
      consoleClientId({ NYUCHI_CONSOLE_WORKOS_CLIENT_ID: "client_x" }),
    ).toBe("client_x");
  });
});

describe("caching, dedupe and expiry", () => {
  it("dedupes concurrent exchanges for one user and token", async () => {
    let release!: (r: Response) => void;
    transport.mockImplementationOnce(
      () => new Promise<Response>((r) => (release = r)),
    );
    const ex = make();
    const token = subject();
    const a = ex.getPersonToken("user_1", token);
    const b = ex.getPersonToken("user_1", token);
    release(granted());
    expect((await a).token).toBe((await b).token);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("caches for at most expires_in − 30 s", async () => {
    const ex = make();
    const token = subject({ exp: T0 / 1000 + 3600 });
    transport.mockImplementation(async () => granted(120));
    await ex.getPersonToken("user_1", token);
    clock = T0 + 120_000 - SAFETY_MARGIN_MS - 1;
    await ex.getPersonToken("user_1", token);
    expect(transport).toHaveBeenCalledTimes(1);
    clock = T0 + 120_000 - SAFETY_MARGIN_MS;
    await ex.getPersonToken("user_1", token);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("never caches longer than 5 minutes", async () => {
    const ex = make();
    const token = subject({ exp: T0 / 1000 + 7200 });
    transport.mockImplementation(async () => granted(3600));
    await ex.getPersonToken("user_1", token);
    clock = T0 + MAX_CACHE_MS - 1;
    await ex.getPersonToken("user_1", token);
    expect(transport).toHaveBeenCalledTimes(1);
    clock = T0 + MAX_CACHE_MS;
    await ex.getPersonToken("user_1", token);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("is bounded by the WorkOS token's own exp", async () => {
    const ex = make();
    const token = subject({ exp: T0 / 1000 + 60 });
    const got = await ex.getPersonToken("user_1", token);
    expect(got.expiresAtMs).toBe(T0 + 60_000);
    clock = T0 + 30_000; // exp − 30 s: no longer usable
    await expect(ex.getPersonToken("user_1", token)).rejects.toMatchObject({
      code: "reauth_required",
    });
  });

  it("refuses a nearly expired WorkOS token without a call", async () => {
    const ex = make();
    await expect(
      ex.getPersonToken("user_1", subject({ exp: T0 / 1000 + 10 })),
    ).rejects.toMatchObject({ code: "reauth_required" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("keys the cache by user and token: a new token or user re-exchanges", async () => {
    const ex = make();
    await ex.getPersonToken("user_1", subject());
    await ex.getPersonToken("user_1", subject({ sid: "s2" }));
    await ex.getPersonToken("user_2", subject());
    expect(transport).toHaveBeenCalledTimes(3);
    expect(ex.cacheSize()).toBe(3);
    ex.forget("user_1");
    expect(ex.cacheSize()).toBe(1);
  });

  it("never caches a failure", async () => {
    const ex = make();
    transport.mockImplementationOnce(async () => fail(503, "x"));
    await expect(ex.getPersonToken("user_1", subject())).rejects.toBeInstanceOf(
      PersonTokenError,
    );
    await ex.getPersonToken("user_1", subject());
    expect(transport).toHaveBeenCalledTimes(2);
  });
});

describe("error mapping (fails closed, no fallback)", () => {
  const cases: [Response | Error, string, number][] = [
    [fail(400, "invalid_grant"), "reauth_required", 401],
    [fail(400, "client_not_allowed"), "wrong_workos_client", 503],
    [fail(404, "person_not_found"), "person_not_provisioned", 409],
    [fail(400, "invalid_scope"), "gateway_unconfigured", 503],
    [fail(400, "unauthorized_client"), "gateway_unconfigured", 503],
    [fail(401, "invalid_client"), "gateway_unconfigured", 503],
    [fail(429, "slow_down", { "retry-after": "7" }), "rate_limited", 429],
    [fail(500, "boom"), "gateway_unavailable", 503],
    [fail(503, "temporarily_unavailable"), "gateway_unavailable", 503],
    [new Response("<html>", { status: 302 }), "gateway_unavailable", 503],
    [new Error("ECONNRESET"), "gateway_unavailable", 503],
    [
      ok({
        access_token: PERSON_JWT,
        scope: "app-keys identity",
        expires_in: 300,
      }),
      "gateway_unavailable",
      503,
    ],
    [
      ok({ access_token: PERSON_JWT, scope: "weather", expires_in: 300 }),
      "gateway_unavailable",
      503,
    ],
    [ok({ scope: "app-keys", expires_in: 300 }), "gateway_unavailable", 503],
    [
      ok({
        access_token: PERSON_JWT,
        scope: "app-keys",
        expires_in: 300,
        account_state: "pending_deletion",
      }),
      "account_pending_deletion",
      403,
    ],
  ];
  for (const [answer, code, status] of cases) {
    it(`${answer instanceof Error ? "transport error" : answer.status} → ${code}`, async () => {
      transport.mockImplementationOnce(async () => {
        if (answer instanceof Error) throw answer;
        return answer;
      });
      const err = await make()
        .getPersonToken("user_1", subject())
        .catch((e) => e);
      expect(err).toBeInstanceOf(PersonTokenError);
      expect(err.code).toBe(code);
      expect(err.status).toBe(status);
      if (code === "rate_limited") expect(err.retryAfterSeconds).toBe(7);
    });
  }

  it("answers gateway_unconfigured when the gateway is not configured", async () => {
    const ex = createPersonTokenExchanger({
      config: () => null,
      consoleClientId: () => CONSOLE,
      now: () => clock,
    });
    await expect(ex.getPersonToken("user_1", subject())).rejects.toMatchObject({
      code: "gateway_unconfigured",
      status: 503,
    });
  });
});

describe("no token or secret in logs or errors", () => {
  it("logs and errors carry neither token nor secret", async () => {
    const token = subject();
    for (const answer of [
      ok({ access_token: PERSON_JWT, scope: "admin", expires_in: 300 }),
      fail(401, "invalid_client"),
    ]) {
      transport.mockImplementationOnce(async () => answer);
      const err = await make()
        .getPersonToken("user_1", token)
        .catch((e) => e);
      const text = `${err.message} ${err.stack}`;
      expect(text).not.toContain(token);
      expect(text).not.toContain(PERSON_JWT);
      expect(text).not.toContain(SECRET);
    }
    await make()
      .getPersonToken("user_1", subject({ client_id: "client_weather" }))
      .catch(() => {});
    expect(warn).toHaveBeenCalled();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(PERSON_JWT);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain("user_1");
  });
});
