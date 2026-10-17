/**
 * /api/app-keys routes: signed-in only, the person's own exchanged token per
 * request, and never a token in a response.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const withAuthMock = vi.hoisted(() => vi.fn());
vi.mock("@workos-inc/authkit-nextjs", () => ({ withAuth: withAuthMock }));

const getPersonTokenMock = vi.hoisted(() => vi.fn());
const forgetMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/gateway-person-token", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/gateway-person-token")
  >("@/lib/gateway-person-token");
  return {
    ...actual,
    getPersonToken: getPersonTokenMock,
    forgetPersonTokens: forgetMock,
  };
});

const rateLimitMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/user-rate-limit", () => ({ checkUserRateLimit: rateLimitMock }));

const warnMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/observability", () => ({
  logWarn: warnMock,
  logError: vi.fn(),
}));

const listMock = vi.hoisted(() => vi.fn());
const createMock = vi.hoisted(() => vi.fn());
const revokeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/gateway-app-keys", async () => {
  const actual = await vi.importActual<typeof import("@/lib/gateway-app-keys")>(
    "@/lib/gateway-app-keys",
  );
  return {
    ...actual,
    appKeys: { list: listMock, create: createMock, revoke: revokeMock },
  };
});

import { PersonTokenError } from "@/lib/gateway-person-token";
import { AppKeysError } from "@/lib/gateway-app-keys";

const ACCESS = "workos.access.token";
const PERSON = "platform.person.token";

beforeEach(() => {
  for (const m of [
    withAuthMock,
    getPersonTokenMock,
    forgetMock,
    listMock,
    createMock,
    revokeMock,
    rateLimitMock,
    warnMock,
  ])
    m.mockReset();
  rateLimitMock.mockResolvedValue({ allowed: true });
  withAuthMock.mockResolvedValue({
    user: { id: "user_1" },
    accessToken: ACCESS,
  });
  getPersonTokenMock.mockResolvedValue({ token: PERSON, scope: "app-keys" });
});

const SITE = "https://weather.mukoko.com";
const post = (
  body: unknown,
  headers: Record<string, string> = {
    "content-type": "application/json",
    origin: SITE,
  },
) =>
  new Request(`${SITE}/api/app-keys`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }) as never;
const del = (
  headers: Record<string, string> = {
    "content-type": "application/json",
    origin: SITE,
  },
) =>
  new Request(`${SITE}/api/app-keys/k_1`, {
    method: "DELETE",
    headers,
  }) as never;
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function noTokens(res: Response) {
  const text = await res.clone().text();
  expect(text).not.toContain(ACCESS);
  expect(text).not.toContain(PERSON);
  expect(res.headers.get("cache-control")).toBe("no-store");
}

describe("anonymous callers get 401 and nothing is exchanged", () => {
  beforeEach(() => withAuthMock.mockResolvedValue({ user: null }));

  it("GET", async () => {
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(401);
    expect(getPersonTokenMock).not.toHaveBeenCalled();
  });
  it("POST", async () => {
    const { POST } = await import("./route");
    expect((await POST(post({ label: "x" }))).status).toBe(401);
    expect(createMock).not.toHaveBeenCalled();
  });
  it("DELETE", async () => {
    const { DELETE } = await import("./[id]/route");
    expect((await DELETE(del(), params("k1"))).status).toBe(401);
    expect(revokeMock).not.toHaveBeenCalled();
  });
});

describe("signed-in", () => {
  it("GET exchanges the user's own access token and lists masked keys", async () => {
    listMock.mockResolvedValue([{ id: "k1", keyPrefix: "nyk_ab" }]);
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(getPersonTokenMock).toHaveBeenCalledWith("user_1", ACCESS);
    expect(listMock).toHaveBeenCalledWith(PERSON);
    await noTokens(res);
    expect((await res.json()).keys).toHaveLength(1);
  });

  it("POST returns the full key once (201)", async () => {
    createMock.mockResolvedValue({ id: "k2", apiKey: "nyk_k2.nys_s" });
    const { POST } = await import("./route");
    const res = await POST(post({ label: "  my site " }));
    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalledWith(PERSON, "my site");
    await noTokens(res);
    expect((await res.json()).key.apiKey).toBe("nyk_k2.nys_s");
  });

  it("POST rejects an empty label", async () => {
    const { POST } = await import("./route");
    const res = await POST(post({ label: "   " }));
    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("DELETE validates the id and revokes", async () => {
    revokeMock.mockResolvedValue(undefined);
    const { DELETE } = await import("./[id]/route");
    expect((await DELETE(del(), params("bad/id"))).status).toBe(400);
    const res = await DELETE(del(), params("k_1"));
    expect(res.status).toBe(200);
    expect(revokeMock).toHaveBeenCalledWith(PERSON, "k_1");
  });
});

describe("CSRF guard on state-changing calls", () => {
  const bad: [string, Record<string, string>, number][] = [
    ["no Origin", { "content-type": "application/json" }, 403],
    [
      "foreign Origin",
      { "content-type": "application/json", origin: "https://evil.example" },
      403,
    ],
    [
      "null Origin",
      { "content-type": "application/json", origin: "null" },
      403,
    ],
    [
      "form content type",
      { "content-type": "application/x-www-form-urlencoded", origin: SITE },
      415,
    ],
    ["text/plain", { "content-type": "text/plain", origin: SITE }, 415],
    ["no content type", { origin: SITE }, 415],
  ];
  for (const [name, headers, status] of bad) {
    it(`POST with ${name} → ${status}, before auth`, async () => {
      const { POST } = await import("./route");
      const res = await POST(post({ label: "x" }, headers));
      expect(res.status).toBe(status);
      expect(withAuthMock).not.toHaveBeenCalled();
      expect(createMock).not.toHaveBeenCalled();
    });
    it(`DELETE with ${name} → ${status}`, async () => {
      const { DELETE } = await import("./[id]/route");
      const res = await DELETE(del(headers), params("k_1"));
      expect(res.status).toBe(status);
      expect(revokeMock).not.toHaveBeenCalled();
    });
  }

  it("accepts a first-party origin and a charset parameter", async () => {
    createMock.mockResolvedValue({ id: "k2", apiKey: "nyk_k2.nys_s" });
    const { POST } = await import("./route");
    const res = await POST(
      post(
        { label: "x" },
        {
          "content-type": "application/json; charset=utf-8",
          origin: "https://weatherstations.nyuchi.com",
        },
      ),
    );
    expect(res.status).toBe(201);
  });

  it("stays out of the open CORS list", async () => {
    const { CORS_POLICY } = await import("@/lib/security-headers");
    expect(CORS_POLICY.open.some((p) => p.includes("app-keys"))).toBe(false);
  });
});

describe("per-user rate limits", () => {
  it("uses the documented limits, keyed on the user id", async () => {
    const { APP_KEYS_LIMITS } = await import("./shared");
    expect(APP_KEYS_LIMITS).toEqual({
      list: [10, 60],
      create: [5, 3600],
      revoke: [20, 3600],
    });
    listMock.mockResolvedValue([]);
    const { GET } = await import("./route");
    await GET();
    expect(rateLimitMock).toHaveBeenCalledWith(
      "app-keys-list",
      "user_1",
      10,
      60,
    );
  });

  it("429 with Retry-After, before any exchange", async () => {
    rateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });
    const { POST } = await import("./route");
    const res = await POST(post({ label: "x" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(getPersonTokenMock).not.toHaveBeenCalled();
  });
});

describe("failures map to token-free answers", () => {
  it("a withAuth() failure is a 401, not a 500", async () => {
    withAuthMock.mockRejectedValueOnce(new Error("no authkit headers"));
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(401);
    expect(getPersonTokenMock).not.toHaveBeenCalled();
  });

  it("logs unexpected errors with ids only", async () => {
    listMock.mockRejectedValueOnce(new TypeError(`bad ${PERSON}`));
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(503);
    const logged = JSON.stringify(warnMock.mock.calls);
    expect(logged).toContain("TypeError");
    expect(logged).not.toContain(PERSON);
    expect(logged).not.toContain(ACCESS);
  });

  const cases: [Error, number, string][] = [
    [
      new PersonTokenError("person_not_provisioned"),
      409,
      "person_not_provisioned",
    ],
    [new PersonTokenError("wrong_workos_client"), 503, "wrong_workos_client"],
    [new PersonTokenError("reauth_required"), 401, "reauth_required"],
    [new PersonTokenError("rate_limited", 9), 429, "rate_limited"],
    [new PersonTokenError("gateway_unavailable"), 503, "gateway_unavailable"],
    [new Error(`boom ${PERSON}`), 503, "gateway_unavailable"],
  ];
  for (const [err, status, code] of cases) {
    it(`${err.message.split(" ")[0]} → ${status}`, async () => {
      getPersonTokenMock.mockRejectedValueOnce(err);
      const { GET } = await import("./route");
      const res = await GET();
      expect(res.status).toBe(status);
      expect((await res.clone().json()).error).toBe(code);
      if (code === "rate_limited")
        expect(res.headers.get("retry-after")).toBe("9");
      await noTokens(res);
      expect(listMock).not.toHaveBeenCalled();
    });
  }

  it("a gateway 401 on app-keys is an operator error and drops the cached token", async () => {
    listMock.mockRejectedValueOnce(
      new AppKeysError(503, "person_token_rejected"),
    );
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("person_token_rejected");
    expect(forgetMock).toHaveBeenCalledWith("user_1");
  });

  it("passes gateway limit codes through", async () => {
    createMock.mockRejectedValueOnce(
      new AppKeysError(409, "key_limit_reached"),
    );
    const { POST } = await import("./route");
    const res = await POST(post({ label: "x" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("key_limit_reached");
  });
});
