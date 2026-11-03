/**
 * /api/couch/session: the guards of /api/app-keys (sign-in, same-origin JSON,
 * per-user limit), a response that is an allow-list, a 503 when the sync grant
 * cannot be issued, and (last describe) the real issuer end to end against a
 * fake gateway that applies nyuchi-api's exchange rules. No network.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  FakeNyuchiGateway,
  workosAccessToken,
} from "@/lib/test-support/fake-nyuchi-gateway";
import { peekClaims } from "@/lib/gateway-person-token";
import { COUCH_SESSION_PATH } from "@/lib/couch-session-timing";
import { SIGNED_OUT_CODE } from "@/lib/couch-session-contract";

const withAuthMock = vi.hoisted(() => vi.fn());
vi.mock("@workos-inc/authkit-nextjs", () => ({ withAuth: withAuthMock }));

const rateLimitMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/user-rate-limit", () => ({ checkUserRateLimit: rateLimitMock }));

// The site-wide budget is tested on its own (`couch-session-budget.test.ts`);
// here the route's use of it is what matters.
const budgetMock = vi.hoisted(() => ({
  spend: vi.fn(),
  noteGatewayRateLimit: vi.fn(),
}));
vi.mock("@/lib/couch-session-budget", () => ({ syncBudget: budgetMock }));

const warnMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/observability", () => ({
  logWarn: warnMock,
  logError: vi.fn(),
}));

const issuerMock = vi.hoisted(() => vi.fn());
const issueMock = vi.hoisted(() => vi.fn());
const precheckMock = vi.hoisted(() => vi.fn());
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
  new Request(`${SITE}${COUCH_SESSION_PATH}`, {
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
    precheckMock,
    budgetMock.spend,
    budgetMock.noteGatewayRateLimit,
  ])
    m.mockReset();
  vi.unstubAllEnvs();
  vi.stubEnv("NYUCHI_API_URL", "https://api.nyuchi.com");
  rateLimitMock.mockResolvedValue({ allowed: true });
  budgetMock.spend.mockResolvedValue({ allowed: true });
  budgetMock.noteGatewayRateLimit.mockReturnValue(true);
  withAuthMock.mockResolvedValue({
    user: { id: "user_1" },
    accessToken: ACCESS,
  });
  // The issuer's local checks pass unless a test says otherwise.
  precheckMock.mockReturnValue(null);
  issuerMock.mockReturnValue({ issue: issueMock, precheck: precheckMock });
  issueMock.mockResolvedValue({
    token: CREDENTIAL,
    expiresInSeconds: 300,
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
    // The code the page matches: a 401 without it never means "signed out".
    expect(await res.clone().json()).toMatchObject({ error: SIGNED_OUT_CODE });
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(issueMock).not.toHaveBeenCalled();
    await noSecrets(res);
  });

  it("401 when AuthKit cannot say who it is (a path it skipped) and the browser sent no session cookie", async () => {
    withAuthMock.mockRejectedValue(new Error("no middleware"));
    const { POST } = await import("./route");
    expect((await POST(post())).status).toBe(401);
  });

  describe("a session cookie with no user is not 'signed out'", () => {
    // AuthKit also answers `{ user: null }` when a refresh of the access token
    // FAILS while the session cookie is intact (its catch block in
    // `session.js`, `updateSession`; a refresh token is single-use, so two
    // requests racing for one has the same shape). The page removes the
    // person's local copy of their settings on a 401 `signed_out`, and a wipe
    // cannot be undone, so a doubt is a 503 and only a request with NO session
    // cookie is the 401.
    const withCookie = (cookie: string) =>
      post({
        "content-type": "application/json",
        origin: SITE,
        cookie,
      });

    it("withAuth gives no user although the cookie is there: 503 couch_unavailable, nothing spent", async () => {
      withAuthMock.mockResolvedValue({ user: null });
      const { POST } = await import("./route");
      const res = await POST(withCookie("wos-session=sealed-by-authkit"));
      expect(res.status).toBe(503);
      expect(await res.clone().json()).toMatchObject({
        error: "couch_unavailable",
      });
      expect(await res.clone().text()).not.toContain(SIGNED_OUT_CODE);
      expect(rateLimitMock).not.toHaveBeenCalled();
      expect(budgetMock.spend).not.toHaveBeenCalled();
      expect(issueMock).not.toHaveBeenCalled();
      await noSecrets(res);
    });

    it("withAuth throwing with the cookie there is the same doubt", async () => {
      withAuthMock.mockRejectedValue(new Error("no middleware"));
      const { POST } = await import("./route");
      const res = await POST(withCookie("wos-session=sealed"));
      expect(res.status).toBe(503);
    });

    it("the transient case ends: the next request, with a user again, is a credential", async () => {
      const { POST } = await import("./route");
      withAuthMock.mockResolvedValueOnce({ user: null });
      expect((await POST(withCookie("wos-session=sealed"))).status).toBe(503);
      expect((await POST(withCookie("wos-session=sealed"))).status).toBe(200);
    });

    it("finds the cookie among others, and only by its exact name", async () => {
      withAuthMock.mockResolvedValue({ user: null });
      const { POST } = await import("./route");
      const status = async (cookie: string) =>
        (await POST(withCookie(cookie))).status;
      expect(await status("a=1; wos-session=abc; b=2")).toBe(503);
      expect(await status("wos-session=abc")).toBe(503);
      // Not the session cookie: an anonymous visitor with other cookies.
      expect(await status("a=1; b=2")).toBe(401);
      expect(await status("xwos-session=abc")).toBe(401);
      expect(await status("wos-session-other=abc")).toBe(401);
      expect(await status("a=wos-session=abc")).toBe(401);
      // A cookie with nothing in it is no session.
      expect(await status("wos-session=")).toBe(401);
      expect(await status("")).toBe(401);
    });

    it("follows WORKOS_COOKIE_NAME, as AuthKit does", async () => {
      vi.stubEnv("WORKOS_COOKIE_NAME", "mukoko-session");
      withAuthMock.mockResolvedValue({ user: null });
      const { POST } = await import("./route");
      expect((await POST(withCookie("mukoko-session=abc"))).status).toBe(503);
      expect((await POST(withCookie("wos-session=abc"))).status).toBe(401);
    });

    it("an anonymous visitor (no cookie) is still the 401 the page acts on", async () => {
      withAuthMock.mockResolvedValue({ user: null });
      const { POST } = await import("./route");
      const res = await POST(post());
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: SIGNED_OUT_CODE });
    });
  });

  it("429 over the per-user limit, with Retry-After, and nothing is issued", async () => {
    rateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });
    const { POST } = await import("./route");
    const res = await POST(post());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(issueMock).not.toHaveBeenCalled();
    // A person over their own limit takes nothing from the site-wide budget.
    expect(budgetMock.spend).not.toHaveBeenCalled();
    expect(rateLimitMock).toHaveBeenCalledWith(
      "couch-session",
      "user_1",
      120,
      3600,
    );
  });
});

describe("the site-wide budget (the gateway's 30 exchanges a minute for this site's one key)", () => {
  it("429 with Retry-After when the site's budget is spent, and nothing is exchanged", async () => {
    budgetMock.spend.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 13,
    });
    const { POST } = await import("./route");
    const res = await POST(post());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("13");
    expect(await res.clone().json()).toMatchObject({ error: "rate_limited" });
    // A refused request must not spend the exchange.
    expect(issueMock).not.toHaveBeenCalled();
    await noSecrets(res);
  });

  it("is asked after sign-in, the configuration, the issuer's local checks and the person's own limit, and before the exchange", async () => {
    const order: string[] = [];
    withAuthMock.mockImplementation(async () => {
      order.push("auth");
      return { user: { id: "user_1" }, accessToken: ACCESS };
    });
    issuerMock.mockImplementation(() => {
      order.push("configured");
      return { issue: issueMock, precheck: precheckMock };
    });
    precheckMock.mockImplementation(() => {
      order.push("precheck");
      return null;
    });
    rateLimitMock.mockImplementation(async () => {
      order.push("person");
      return { allowed: true };
    });
    budgetMock.spend.mockImplementation(async () => {
      order.push("site");
      return { allowed: true };
    });
    issueMock.mockImplementation(async () => {
      order.push("exchange");
      return {
        token: CREDENTIAL,
        expiresInSeconds: 300,
        database: `user_${PERSON}`,
      };
    });
    const { POST } = await import("./route");
    expect((await POST(post())).status).toBe(200);
    expect(order).toEqual([
      "auth",
      "configured",
      "precheck",
      "person",
      "site",
      "exchange",
    ]);
  });

  it("an anonymous visitor, an unconfigured site and a person over their own limit never touch it", async () => {
    const { POST } = await import("./route");
    withAuthMock.mockResolvedValueOnce({ user: null });
    await POST(post());
    issuerMock.mockReturnValueOnce(null);
    await POST(post());
    rateLimitMock.mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 3,
    });
    await POST(post());
    expect(budgetMock.spend).not.toHaveBeenCalled();
  });

  it("the gateway answering 429 anyway is noted, so this instance stops sending exchanges, and logged once with no person in it", async () => {
    issueMock.mockRejectedValue(new CouchIssueError("rate_limited", 17));
    const { POST } = await import("./route");
    const res = await POST(post());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
    expect(budgetMock.noteGatewayRateLimit).toHaveBeenCalledWith(17);
    expect(warnMock).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warnMock.mock.calls);
    expect(logged).not.toContain("user_1");
    expect(logged).not.toContain(ACCESS);
    expect(logged).not.toContain(CREDENTIAL);

    // A second 429 inside the same cooldown is not logged again.
    budgetMock.noteGatewayRateLimit.mockReturnValue(false);
    warnMock.mockClear();
    await POST(post());
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("no other refusal begins a cooldown", async () => {
    const { POST } = await import("./route");
    for (const code of [
      "account_pending_deletion",
      "couch_unavailable",
    ] as const) {
      issueMock.mockRejectedValue(new CouchIssueError(code));
      await POST(post());
    }
    issueMock.mockRejectedValue(new Error("boom"));
    await POST(post());
    expect(budgetMock.noteGatewayRateLimit).not.toHaveBeenCalled();
  });
});

// The issuer's cheap LOCAL checks (an access token that is missing, ended or
// too short to make a grant from) cannot be passed by retrying at once, so a
// request that fails them must not spend the person's hourly allowance (a Mongo
// write) or one of the site's exchanges, which a person stuck with such a token
// would otherwise burn on every retry of every tab.
describe("the issuer's local checks come before any counter", () => {
  it("a failed check is 503 couch_unavailable and spends neither the person's allowance nor the site's budget", async () => {
    precheckMock.mockReturnValue(new CouchIssueError("couch_unavailable"));
    const { POST } = await import("./route");
    const res = await POST(post());
    expect(res.status).toBe(503);
    expect(await res.clone().json()).toMatchObject({
      error: "couch_unavailable",
    });
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(budgetMock.spend).not.toHaveBeenCalled();
    expect(issueMock).not.toHaveBeenCalled();
    expect(budgetMock.noteGatewayRateLimit).not.toHaveBeenCalled();
    await noSecrets(res);
  });

  it("is given who is asking: the user and the access token, and nothing else", async () => {
    const { POST } = await import("./route");
    await POST(post());
    expect(precheckMock).toHaveBeenCalledWith({
      userId: "user_1",
      accessToken: ACCESS,
    });
  });

  it("is never reached by an anonymous visitor, a session cookie without a user or an unconfigured site", async () => {
    const { POST } = await import("./route");
    withAuthMock.mockResolvedValueOnce({ user: null });
    await POST(post());
    issuerMock.mockReturnValueOnce(null);
    await POST(post());
    expect(precheckMock).not.toHaveBeenCalled();
  });

  it("when the check passes, both counters are spent once and the exchange runs", async () => {
    const { POST } = await import("./route");
    expect((await POST(post())).status).toBe(200);
    expect(precheckMock).toHaveBeenCalledTimes(1);
    expect(rateLimitMock).toHaveBeenCalledTimes(1);
    expect(budgetMock.spend).toHaveBeenCalledTimes(1);
    expect(issueMock).toHaveBeenCalledTimes(1);
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
    // Sync is not configured here: the answer costs the person nothing.
    expect(rateLimitMock).not.toHaveBeenCalled();
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
    // No Mongo write for a route that can do nothing.
    expect(rateLimitMock).not.toHaveBeenCalled();
  });

  it("an unconfigured site still tells an anonymous visitor 401, and spends nothing either way", async () => {
    issuerMock.mockReturnValue(null);
    withAuthMock.mockResolvedValue({ user: null });
    const { POST } = await import("./route");
    expect((await POST(post())).status).toBe(401);
    expect(rateLimitMock).not.toHaveBeenCalled();
  });

  it("a configured site spends the person's hourly allowance and one exchange of the site's budget only once the answer needs the gateway", async () => {
    const { POST } = await import("./route");
    await POST(post());
    expect(rateLimitMock).toHaveBeenCalledTimes(1);
    expect(budgetMock.spend).toHaveBeenCalledTimes(1);
    expect(issueMock).toHaveBeenCalledTimes(1);
  });
});

describe("when a credential is issued", () => {
  it("answers exactly token, expiresIn, database and apiOrigin: a duration, no time of day", async () => {
    const { POST } = await import("./route");
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(await noSecrets(res)).not.toContain("workos");
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual([
      "apiOrigin",
      "database",
      "expiresIn",
      "token",
    ]);
    expect(body).toEqual({
      token: CREDENTIAL,
      expiresIn: 300,
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
      expiresInSeconds: 300,
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
    // Not even a time of day the issuer might still carry.
    expect(text).not.toContain("2026-11-02");
    expect(text).not.toContain("expiresAt");
  });

  // (That a credential is well formed, names a personal database and has not
  // ended is the issuer's job and is tested there, once: `toCredential` in
  // `couch-session-issuer.test.ts`. The route does not check it a second time;
  // it still answers 503 if the issuer hands it a duration the page could not
  // use.)
  it("503 if the issuer hands over a duration that is not a positive whole number of seconds, and the text never carries the token", async () => {
    const { POST } = await import("./route");
    for (const expiresInSeconds of [
      Number.NaN,
      0,
      -3,
      Number.POSITIVE_INFINITY,
      2.5,
      undefined,
    ]) {
      issueMock.mockResolvedValue({
        token: CREDENTIAL,
        expiresInSeconds,
        database: `user_${PERSON}`,
      });
      const res = await POST(post());
      expect(res.status, String(expiresInSeconds)).toBe(503);
      expect(await res.text()).not.toContain(CREDENTIAL);
    }
  });

  it("maps the issuer's own refusals to their status and code", async () => {
    const { POST } = await import("./route");
    for (const [code, status] of [
      [SIGNED_OUT_CODE, 401],
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

describe("the route file", () => {
  it("explains once why it checks that sync is set up before it spends the person's allowance", () => {
    const source = readFileSync(`${__dirname}/route.ts`, "utf8");
    expect(source.match(/Not configured here/g)).toHaveLength(1);
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
    const body = (await res.json()) as Record<string, string | number>;
    expect(Object.keys(body).sort()).toEqual([
      "apiOrigin",
      "database",
      "expiresIn",
      "token",
    ]);
    expect(body.apiOrigin).toBe("https://api.nyuchi.com");
    expect(body.database).toBe(`user_${PERSON}`);

    // The token is the sync grant, not a sign-in and not the WorkOS token.
    expect(body.token).not.toBe(at);
    expect(peekClaims(body.token as string)).toMatchObject({
      sub: PERSON,
      aud: "couch-sync",
      scope: "couch:user",
      act: { sub: KEY_ID },
    });
    // A duration from the server's clock at issue time, whole seconds.
    expect(Number.isInteger(body.expiresIn)).toBe(true);
    expect(body.expiresIn as number).toBeGreaterThan(250);
    expect(body.expiresIn as number).toBeLessThanOrEqual(300);
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

  it("a signed-in person whose WorkOS token has ended (a refresh that failed) is told to retry later, not that the session ended", async () => {
    withAuthMock.mockResolvedValue({
      user: { id: WORKOS_USER },
      accessToken: freshAccessToken(-30),
    });
    const { POST } = await import("./route");
    const res = await POST(post());
    // 401 would make the page forget this person's settings on this device.
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "couch_unavailable" });
    expect(gateway.requests).toEqual([]);
    // ...and it cost the person and the site nothing.
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(budgetMock.spend).not.toHaveBeenCalled();
  });

  it("a missing access token (AuthKit's refresh failed) is 503 too, and spends nothing", async () => {
    withAuthMock.mockResolvedValue({
      user: { id: WORKOS_USER },
      accessToken: undefined,
    });
    const { POST } = await import("./route");
    const res = await POST(post());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "couch_unavailable" });
    expect(gateway.requests).toEqual([]);
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(budgetMock.spend).not.toHaveBeenCalled();
  });

  it("nobody signed in is still 401", async () => {
    withAuthMock.mockResolvedValue({ user: null });
    const { POST } = await import("./route");
    expect((await POST(post())).status).toBe(401);
  });

  it("the grant is never longer than the WorkOS token it came from", async () => {
    withAuthMock.mockResolvedValue({
      user: { id: WORKOS_USER },
      accessToken: freshAccessToken(150),
    });
    const { POST } = await import("./route");
    const body = (await (await POST(post())).json()) as { expiresIn: number };
    expect(body.expiresIn).toBeGreaterThan(100);
    expect(body.expiresIn).toBeLessThanOrEqual(150);
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

  it("the gateway refusing the token of a person who IS signed in is a retry (503), never the 401 that means 'signed out'", async () => {
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
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "couch_unavailable" });
  });

  it("the only 401 is the route's own, when nobody is signed in, and it says so with a code", async () => {
    withAuthMock.mockResolvedValue({ user: null });
    const { POST } = await import("./route");
    const res = await POST(post());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: SIGNED_OUT_CODE });
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
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(budgetMock.spend).not.toHaveBeenCalled();
  });

  it("an access token that is long enough is exchanged, and then both counters are spent", async () => {
    const { POST } = await import("./route");
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(rateLimitMock).toHaveBeenCalledTimes(1);
    expect(budgetMock.spend).toHaveBeenCalledTimes(1);
    expect(gateway.requests).toHaveLength(1);
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
