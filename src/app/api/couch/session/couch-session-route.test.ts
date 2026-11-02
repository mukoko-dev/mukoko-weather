/**
 * /api/couch/session: the guards of /api/app-keys (sign-in, same-origin JSON,
 * per-user limit), a response that is an allow-list, and a 503 until the
 * gateway can issue this site a credential.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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
  for (const m of [withAuthMock, rateLimitMock, warnMock, issuerMock, issueMock])
    m.mockReset();
  vi.stubEnv("NYUCHI_API_URL", "https://api.nyuchi.com");
  rateLimitMock.mockResolvedValue({ allowed: true });
  withAuthMock.mockResolvedValue({ user: { id: "user_1" }, accessToken: ACCESS });
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
    const res = await POST(post({ origin: SITE, "content-type": "text/plain" }));
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
    expect(rateLimitMock).toHaveBeenCalledWith("couch-session", "user_1", 30, 3600);
  });
});

describe("503 until the gateway can issue a credential", () => {
  it("the real issuer is not implemented, so a signed-in person gets couch_unavailable", async () => {
    // The module's own answer, not the mock's: no implementation exists.
    const actual = await vi.importActual<
      typeof import("@/lib/couch-session-issuer")
    >("@/lib/couch-session-issuer");
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
    for (const value of ["", "http://api.nyuchi.com", "https://api.nyuchi.com/v1"]) {
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
    expect(issueMock).toHaveBeenCalledWith({ userId: "user_1", accessToken: ACCESS });
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
      { token: CREDENTIAL, expiresAtMs: Number.NaN, database: `user_${PERSON}` },
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
