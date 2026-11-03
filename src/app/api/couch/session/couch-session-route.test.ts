/**
 * /api/couch/session: the guards of /api/app-keys (sign-in, same-origin JSON,
 * per-user limit), a response that is an allow-list, a 503 when the sync grant
 * cannot be issued, and (last describe) the real issuer end to end against a
 * fake gateway that applies nyuchi-api's exchange rules. No network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  FakeNyuchiGateway,
  workosAccessToken,
} from "@/lib/test-support/fake-nyuchi-gateway";
import { peekClaims } from "@/lib/gateway-person-token";

const withAuthMock = vi.hoisted(() => vi.fn());
vi.mock("@workos-inc/authkit-nextjs", () => ({ withAuth: withAuthMock }));

const rateLimitMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/user-rate-limit", () => ({ checkUserRateLimit: rateLimitMock }));

const warnMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/observability", () => ({
  logWarn: warnMock,
  logError: vi.fn(),
}));

const issuerMock = vi.hoisted(() => vi.fn());
const issueMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/couch-session-issuer", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/couch-session-issuer")
  >("@/lib/couch-session-issuer");
  return { ...actual, couchSessionIssuer: issuerMock };
});

import { CouchIssueError } from "@/lib/couch-session-issuer";

const SITE = "https://weather.mukoko.com";
const ACCESS = "workos.access.token";
const CREDENTIAL = "short-lived-credential-0123456789";
const PERSON = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

const post = (
  headers: Record<string, string> = {
    "content-type": "application/json",
    origin: SITE,
  },
  body: unknown = {},
) =>
  new Request(`${SITE}/api/couch/session`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }) as never;

beforeEach(() => {
  for (const m of [
    withAuthMock,
    rateLimitMock,
    warnMock,
    issuerMock,
    issueMock,
  ])
    m.mockReset();
  vi.stubEnv("NYUCHI_API_URL", "https://api.nyuchi.com");
  rateLimitMock.mockResolvedValue({ allowed: true });
  withAuthMock.mockResolvedValue({
    user: { id: "user_1" },
    accessToken: ACCESS,
  });
  issuerMock.mockReturnValue({ issue: issueMock });
  issueMock.mockResolvedValue({
    token: CREDENTIAL,
    expiresAtMs: Date.parse("2026-11-02T10:10:00.000Z"),
    database: `user_${PERSON}`,
  });
});

async function noSecrets(res: Response) {
  const text = await res.clone().text();
  expect(text).not.toContain(ACCESS);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return text;
}

describe("guards, in order", () => {
  it("415 without application/json, before anything else runs", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      post({ origin: SITE, "content-type": "text/plain" }),
    );
    expect(res.status).toBe(415);
    expect(withAuthMock).not.toHaveBeenCalled();
    expect(issueMock).not.toHaveBeenCalled();
    await noSecrets(res);
  });

  it("403 for a cross-site, missing or null Origin", async () => {
    const { POST } = await import("./route");
    for (const origin of [
      "https://evil.example",
      "https://weather.mukoko.com.evil.example",
      "null",
      undefined,
    ]) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (origin) headers.origin = origin;
      const res = await POST(post(headers));
      expect(res.status, String(origin)).toBe(403);
    }
    expect(withAuthMock).not.toHaveBeenCalled();
    expect(issueMock).not.toHaveBeenCalled();
  });

  it("401 when anonymous: no limiter, no issuer", async () => {
    withAuthMock.mockResolvedValue({ user: null });
    const { POST } = await import("./route");
    const res = await POST(post());
    expect(res.status).toBe(401);
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(issueMock).not.toHaveBeenCalled();
    await noSecrets(res);
  });

  it("401 when AuthKit cannot say who it is (a path it skipped)", async () => {
    withAuthMock.mockRejectedValue(new Error("no middleware"));
    const { POST } = await import("./route");
    expect((await POST(post())).status).toBe(401);
  });

  it("429 over the per-user limit, with Retry-After, and nothing is issued", async () => {
    rateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });
    const { POST } = await import("./route");
    const res = await POST(post());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(issueMock).not.toHaveBeenCalled();
    expect(rateLimitMock).toHaveBeenCalledWith(
      "couch-session",
      "user_1",
      120,
      3600,
    );
  });
});

describe("503 when the sync grant cannot be issued", () => {
  it("without an issuer (this app's key or WORKOS_CLIENT_ID missing) a signed-in person gets couch_unavailable", async () => {
    // The module's own answer, not the mock's.
    const actual = await vi.importActual<
      typeof import("@/lib/couch-session-issuer")
    >("@/lib/couch-session-issuer");
    vi.stubEnv("NYUCHI_APP_KEYS_API_KEY", "");
    vi.stubEnv("WORKOS_CLIENT_ID", "");
    expect(actual.couchSessionIssuer()).toBeNull();

    issuerMock.mockReturnValue(null);
    const { POST } = await import("./route");
    const res = await POST(post());
    expect(res.status).toBe(503);
    await noSecrets(res);
    expect(await res.json()).toMatchObject({ error: "couch_unavailable" });
  });

  it("503 when NYUCHI_API_URL is unset or not a bare https origin", async () => {
    const { POST } = await import("./route");
    for (const value of [
      "",
      "http://api.nyuchi.com",
      "https://api.nyuchi.com/v1",
    ]) {
      vi.stubEnv("NYUCHI_API_URL", value);
      const res = await POST(post());
      expect(res.status, value).toBe(503);
    }
    expect(issueMock).not.toHaveBeenCalled();
  });
});

describe("when a credential is issued", () => {
  it("answers exactly token, expiresAt, database and apiOrigin", async () => {
    const { POST } = await import("./route");
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(await noSecrets(res)).not.toContain("workos");
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual([
      "apiOrigin",
      "database",
      "expiresAt",
      "token",
    ]);
    expect(body).toEqual({
      token: CREDENTIAL,
      expiresAt: "2026-11-02T10:10:00.000Z",
      database: `user_${PERSON}`,
      apiOrigin: "https://api.nyuchi.com",
    });
    expect(issueMock).toHaveBeenCalledWith({
      userId: "user_1",
      accessToken: ACCESS,
    });
  });

  it("drops any extra field the issuer returns", async () => {
    issueMock.mockResolvedValue({
      token: CREDENTIAL,
      expiresAtMs: Date.parse("2026-11-02T10:10:00.000Z"),
      database: `user_${PERSON}`,
      refreshToken: "must-not-leak",
      email: "person@example.com",
      databases: { families: ["family_x"] },
    });
    const { POST } = await import("./route");
    const text = await (await POST(post())).text();
    expect(text).not.toContain("must-not-leak");
    expect(text).not.toContain("person@example.com");
    expect(text).not.toContain("family_x");
  });

  it("503 for a credential that is malformed, not a personal database, or unreadable", async () => {
    const { POST } = await import("./route");
    for (const bad of [
      { token: "short", expiresAtMs: 1, database: `user_${PERSON}` },
      {
        token: CREDENTIAL,
        expiresAtMs: Number.NaN,
        database: `user_${PERSON}`,
      },
      { token: CREDENTIAL, expiresAtMs: 1, database: "family_abc" },
      { token: CREDENTIAL, expiresAtMs: 1, database: "user_" },
    ]) {
      issueMock.mockResolvedValue(bad);
      const res = await POST(post());
      expect(res.status, JSON.stringify(bad)).toBe(503);
      expect(await res.text()).not.toContain(CREDENTIAL);
    }
  });

  it("maps the issuer's own refusals to their status and code", async () => {
    const { POST } = await import("./route");
    for (const [code, status] of [
      ["reauth_required", 401],
      ["account_pending_deletion", 403],
      ["rate_limited", 429],
      ["couch_unavailable", 503],
    ] as const) {
      issueMock.mockRejectedValue(new CouchIssueError(code, 9));
      const res = await POST(post());
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ error: code });
    }
  });

  it("an unexpected error is 503, logged by name only, never with its text", async () => {
    issueMock.mockRejectedValue(
      new Error(`boom ${CREDENTIAL} ${ACCESS} https://api.nyuchi.com/x`),
    );
    const { POST } = await import("./route");
    const res = await POST(post());
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain(CREDENTIAL);
    expect(warnMock).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warnMock.mock.calls);
    expect(logged).not.toContain(CREDENTIAL);
    expect(logged).not.toContain(ACCESS);
    expect(logged).not.toContain("api.nyuchi.com");
  });
});

describe("nothing else is exposed", () => {
  it("only POST is a handler, and the route is not CORS-open", async () => {
    const mod = await import("./route");
    expect(Object.keys(mod).sort()).toEqual(["POST", "dynamic"]);
    const { CORS_POLICY } = await import("@/lib/security-headers");
    const open = JSON.stringify(CORS_POLICY.open);
    expect(open).not.toContain("couch");
  });
});

describe("end to end: the real issuer, the exchange rules of nyuchi-api, a fake gateway", () => {
  const KEY_ID = "nyk_weatherkey01";
  const KEY_SECRET = "nys_supersecretvalue123";
  const WORKOS_CLIENT = "client_mukoko_account";
  const WORKOS_USER = "user_1";
  let gateway: FakeNyuchiGateway;
  let sessionCounter = 0;
  let at: string;

  const freshAccessToken = (lifeSeconds = 300, clientId = WORKOS_CLIENT) => {
    // A new `sid` each time: the issuer remembers a failure per user + token.
    sessionCounter += 1;
    return workosAccessToken({
      sub: WORKOS_USER,
      clientId,
      lifeSeconds,
      sid: `session_${sessionCounter}`,
    });
  };

  beforeEach(async () => {
    const actual = await vi.importActual<
      typeof import("@/lib/couch-session-issuer")
    >("@/lib/couch-session-issuer");
    issuerMock.mockImplementation(actual.couchSessionIssuer);
    vi.stubEnv("NYUCHI_APP_KEYS_API_KEY", `${KEY_ID}.${KEY_SECRET}`);
    vi.stubEnv("WORKOS_CLIENT_ID", WORKOS_CLIENT);
    gateway = new FakeNyuchiGateway({
      consoleClientId: WORKOS_CLIENT,
      keys: {
        [KEY_ID]: {
          secret: KEY_SECRET,
          type: "internal",
          scopes: ["identity", "app-keys", "weather"],
        },
      },
      syncClientIds: [KEY_ID],
      persons: { [WORKOS_USER]: { id: PERSON } },
    });
    // The server's `fetchTransport` reaches the gateway through global fetch.
    vi.stubGlobal("fetch", gateway.fetch);
    at = freshAccessToken();
    withAuthMock.mockResolvedValue({
      user: { id: WORKOS_USER },
      accessToken: at,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("a signed-in person gets the gateway's sync grant, shaped as the page expects", async () => {
    const { POST } = await import("./route");
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual([
      "apiOrigin",
      "database",
      "expiresAt",
      "token",
    ]);
    expect(body.apiOrigin).toBe("https://api.nyuchi.com");
    expect(body.database).toBe(`user_${PERSON}`);

    // The token is the sync grant, not a sign-in and not the WorkOS token.
    expect(body.token).not.toBe(at);
    expect(peekClaims(body.token)).toMatchObject({
      sub: PERSON,
      aud: "couch-sync",
      scope: "couch:user",
      act: { sub: KEY_ID },
    });
    const ends = Date.parse(body.expiresAt);
    expect(ends - Date.now()).toBeGreaterThan(250_000);
    expect(ends - Date.now()).toBeLessThanOrEqual(300_000);
    // The gateway accepts it for this person's database, as the proxy would.
    expect(gateway.authorize(`Bearer ${body.token}`)).toMatchObject({
      ok: true,
      claims: { sub: PERSON },
    });
  });

  it("asked exactly one question of the gateway: couch:user, alone, as the app's own key", async () => {
    const { POST } = await import("./route");
    await POST(post());
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0].form).toMatchObject({
      scope: "couch:user",
      client_id: KEY_ID,
      subject_token: at,
    });
  });

  it("the page asking again gets a new grant, not the old one", async () => {
    const { POST } = await import("./route");
    const first = (await (await POST(post())).json()) as { token: string };
    const second = (await (await POST(post())).json()) as { token: string };
    expect(second.token).not.toBe(first.token);
    expect(gateway.requests).toHaveLength(2);
  });

  it("the grant is never longer than the WorkOS token it came from", async () => {
    withAuthMock.mockResolvedValue({
      user: { id: WORKOS_USER },
      accessToken: freshAccessToken(150),
    });
    const { POST } = await import("./route");
    const body = (await (await POST(post())).json()) as { expiresAt: string };
    const left = Date.parse(body.expiresAt) - Date.now();
    expect(left).toBeGreaterThan(100_000);
    expect(left).toBeLessThanOrEqual(150_000);
  });

  it.each([
    [
      "the gateway is down",
      { status: 503, count: 1 },
      503,
      "couch_unavailable",
    ],
    ["the gateway fails", { status: 500, count: 1 }, 503, "couch_unavailable"],
    [
      "the gateway cannot be reached",
      { status: 0, count: 1 },
      503,
      "couch_unavailable",
    ],
    [
      "the gateway says slow down",
      { status: 429, count: 1, retryAfter: "30" },
      429,
      "rate_limited",
    ],
  ])(
    "%s: the answer carries the mapped status and nothing secret",
    async (_why, fail, status, error) => {
      gateway.failNext = fail;
      const { POST } = await import("./route");
      const res = await POST(post());
      expect(res.status).toBe(status);
      if (status === 429) expect(res.headers.get("retry-after")).toBe("30");
      const text = await noSecretsOf(res, [at, KEY_SECRET]);
      expect(JSON.parse(text)).toMatchObject({ error });
    },
  );

  it("a client that is not on the gateway's allow-list: 503, and the log names the refusal but no secret", async () => {
    gateway.syncClientIds.clear();
    const { POST } = await import("./route");
    const res = await POST(post());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "couch_unavailable" });
    const logged = JSON.stringify(warnMock.mock.calls);
    expect(logged).toContain("invalid_scope");
    expect(logged).not.toContain(KEY_SECRET);
    expect(logged).not.toContain(at);
  });

  it("a person whose deletion is scheduled: 403 account_pending_deletion", async () => {
    gateway = new FakeNyuchiGateway({
      consoleClientId: WORKOS_CLIENT,
      keys: {
        [KEY_ID]: {
          secret: KEY_SECRET,
          type: "internal",
          scopes: ["identity"],
        },
      },
      syncClientIds: [KEY_ID],
      persons: { [WORKOS_USER]: { id: PERSON, deletionScheduled: true } },
    });
    vi.stubGlobal("fetch", gateway.fetch);
    const { POST } = await import("./route");
    const res = await POST(post());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: "account_pending_deletion",
    });
  });

  it("a session the gateway says has ended: 401 reauth_required", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            detail: {
              error: "invalid_grant",
              error_description: "The WorkOS session has ended.",
            },
          }),
          { status: 400 },
        ),
    );
    const { POST } = await import("./route");
    const res = await POST(post());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "reauth_required" });
  });

  it("a WorkOS token from another client is never sent to the gateway: 503", async () => {
    withAuthMock.mockResolvedValue({
      user: { id: WORKOS_USER },
      accessToken: freshAccessToken(300, "client_somebody_else"),
    });
    const { POST } = await import("./route");
    const res = await POST(post());
    expect(res.status).toBe(503);
    expect(gateway.requests).toEqual([]);
  });

  it("a WorkOS token about to end is not exchanged: 503, so the page backs off instead of looping", async () => {
    withAuthMock.mockResolvedValue({
      user: { id: WORKOS_USER },
      accessToken: freshAccessToken(60),
    });
    const { POST } = await import("./route");
    const res = await POST(post());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "couch_unavailable" });
    expect(gateway.requests).toEqual([]);
  });

  it("without this app's key or the gateway origin the gateway is never called", async () => {
    const { POST } = await import("./route");
    vi.stubEnv("NYUCHI_APP_KEYS_API_KEY", "");
    expect((await POST(post())).status).toBe(503);
    vi.stubEnv("NYUCHI_APP_KEYS_API_KEY", `${KEY_ID}.${KEY_SECRET}`);
    vi.stubEnv("WORKOS_CLIENT_ID", "");
    expect((await POST(post())).status).toBe(503);
    vi.stubEnv("WORKOS_CLIENT_ID", WORKOS_CLIENT);
    vi.stubEnv("NYUCHI_API_URL", "");
    expect((await POST(post())).status).toBe(503);
    expect(gateway.requests).toEqual([]);
  });

  it("anonymous, cross-site and over-the-limit requests never reach the gateway", async () => {
    const { POST } = await import("./route");
    withAuthMock.mockResolvedValue({ user: null });
    expect((await POST(post())).status).toBe(401);
    withAuthMock.mockResolvedValue({
      user: { id: WORKOS_USER },
      accessToken: at,
    });
    expect(
      (
        await POST(
          post({
            "content-type": "application/json",
            origin: "https://evil.example",
          }),
        )
      ).status,
    ).toBe(403);
    rateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 5 });
    expect((await POST(post())).status).toBe(429);
    expect(gateway.requests).toEqual([]);
  });

  it("neither the WorkOS token, the key secret nor any log line leaks into an answer", async () => {
    const { POST } = await import("./route");
    const ok = await POST(post());
    await noSecretsOf(ok, [at, KEY_SECRET], false);
    for (const line of warnMock.mock.calls) {
      const text = JSON.stringify(line);
      expect(text).not.toContain(at);
      expect(text).not.toContain(KEY_SECRET);
    }
  });

  async function noSecretsOf(
    res: Response,
    secrets: string[],
    cached = true,
  ): Promise<string> {
    const text = await res.clone().text();
    for (const secret of secrets) expect(text).not.toContain(secret);
    if (cached) expect(res.headers.get("cache-control")).toBe("no-store");
    return text;
  }
});
