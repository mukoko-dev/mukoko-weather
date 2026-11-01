/**
 * Auth-gated AI proxy tests.
 *
 * The proxy MUST:
 *   1. Reject unauthenticated requests with HTTP 401 and contact nothing.
 *   2. Send the weather summary (the bare /api/ai) to the internal weather
 *      Worker with the service key, the person's id and address, and never the
 *      session cookie, the email or the key in the answer.
 *   3. Still forward followup / agriculture to /api/py/ai/* with the user's
 *      identity (until they are ported).
 *   4. Pass the Worker's status and Retry-After through.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock AuthKit before importing the route — the route calls withAuth() at
// request time, and we need to swap the return value per test.
const withAuthMock = vi.fn();
vi.mock("@workos-inc/authkit-nextjs", () => ({
  withAuth: withAuthMock,
}));

const originalFetch = globalThis.fetch;
const fetchMock = vi.fn();

beforeEach(() => {
  withAuthMock.mockReset();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  vi.stubEnv("WEATHER_SERVICE_URL", "https://weather-internal.mukoko.com");
  vi.stubEnv("WEATHER_SERVICE_API_KEY", "svc-key");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
});

/** Build a minimal NextRequest-shaped object. */
function makeRequest(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: BodyInit;
  } = {},
): Request {
  return new Request(url, {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.body,
  });
}

const summaryBody = JSON.stringify({
  location: { slug: "harare", name: "Harare", lat: -17.83, lon: 31.05 },
  activities: ["running"],
});

describe("auth-gated AI proxy", () => {
  it("returns 401 when withAuth() resolves a null user", async () => {
    withAuthMock.mockResolvedValueOnce({ user: null });

    const mod = await import("./route");
    for (const path of [undefined, ["followup"]]) {
      withAuthMock.mockResolvedValueOnce({ user: null });
      const req = makeRequest("https://weather.mukoko.com/api/ai", {
        method: "POST",
      });
      const res = await mod.POST(req as never, {
        params: Promise.resolve({ path }),
      });
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("unauthorized");
    }
    // Nothing is contacted when auth fails.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the weather summary goes to the internal weather Worker", () => {
  it("POSTs the body with the service key, the person and their address", async () => {
    withAuthMock.mockResolvedValueOnce({
      user: { id: "user_abc", email: "bryan@nyuchi.com" },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ insight: "Warm.", cached: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const mod = await import("./route");
    const req = makeRequest("https://weather.mukoko.com/api/ai", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "wos-session=secret",
        "x-forwarded-for": "203.0.113.9, 10.0.0.1",
      },
      body: summaryBody,
    });
    const res = await mod.POST(req as never, {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ insight: "Warm.", cached: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://weather-internal.mukoko.com/internal/ai/summary",
    );
    expect(init.method).toBe("POST");
    expect(init.body).toBe(summaryBody);
    expect(init.redirect).toBe("manual");
    const headers = init.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer svc-key");
    expect(headers.get("x-mukoko-user-id")).toBe("user_abc");
    expect(headers.get("x-mukoko-client-ip")).toBe("203.0.113.9");
    expect(headers.get("content-type")).toBe("application/json");
    // Neither the session cookie nor the email crosses.
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("x-mukoko-user-email")).toBeNull();
    // The key never reaches the browser.
    expect(JSON.stringify([...res.headers])).not.toContain("svc-key");
  });

  it("passes the Worker's status and Retry-After through", async () => {
    withAuthMock.mockResolvedValueOnce({ user: { id: "u1", email: null } });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: { "retry-after": "600", "content-type": "application/json" },
      }),
    );
    const mod = await import("./route");
    const res = await mod.POST(
      makeRequest("https://weather.mukoko.com/api/ai", {
        method: "POST",
        body: summaryBody,
      }) as never,
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("600");
  });

  it("answers 503 when the Worker is not configured, and never calls out", async () => {
    vi.stubEnv("WEATHER_SERVICE_API_KEY", "");
    withAuthMock.mockResolvedValueOnce({ user: { id: "u1", email: null } });
    const mod = await import("./route");
    const res = await mod.POST(
      makeRequest("https://weather.mukoko.com/api/ai", {
        method: "POST",
        body: summaryBody,
      }) as never,
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a Worker URL that is not a bare https origin, so the key goes nowhere else", async () => {
    vi.stubEnv("WEATHER_SERVICE_URL", "http://evil.example");
    withAuthMock.mockResolvedValueOnce({ user: { id: "u1", email: null } });
    const mod = await import("./route");
    const res = await mod.POST(
      makeRequest("https://weather.mukoko.com/api/ai", {
        method: "POST",
        body: summaryBody,
      }) as never,
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 405 to anything but POST and 413 to an oversized body", async () => {
    const mod = await import("./route");
    withAuthMock.mockResolvedValueOnce({ user: { id: "u1", email: null } });
    const get = await mod.GET(
      makeRequest("https://weather.mukoko.com/api/ai") as never,
      { params: Promise.resolve({}) },
    );
    expect(get.status).toBe(405);

    withAuthMock.mockResolvedValueOnce({ user: { id: "u1", email: null } });
    const big = await mod.POST(
      makeRequest("https://weather.mukoko.com/api/ai", {
        method: "POST",
        body: "x".repeat(70 * 1024),
      }) as never,
      { params: Promise.resolve({}) },
    );
    expect(big.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 502 when the Worker does not answer", async () => {
    withAuthMock.mockResolvedValueOnce({ user: { id: "u1", email: null } });
    fetchMock.mockRejectedValueOnce(new Error("network"));
    const mod = await import("./route");
    const res = await mod.POST(
      makeRequest("https://weather.mukoko.com/api/ai", {
        method: "POST",
        body: summaryBody,
      }) as never,
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(502);
  });
});

describe("followup and agriculture still go to the Python functions", () => {
  it("forwards authenticated POSTs to /api/py/ai/<path> with X-Mukoko-User-* headers", async () => {
    withAuthMock.mockResolvedValueOnce({
      user: { id: "user_abc", email: "bryan@nyuchi.com" },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const mod = await import("./route");
    const params = Promise.resolve({ path: ["followup"] });
    const req = makeRequest(
      "https://weather.mukoko.com/api/ai/followup?lang=en",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "wos-session=secret",
        },
        body: JSON.stringify({ message: "hi" }),
      },
    );

    const res = await mod.POST(req as never, { params });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [upstreamUrl, upstreamInit] = fetchMock.mock.calls[0];
    expect(String(upstreamUrl)).toBe(
      "https://weather.mukoko.com/api/py/ai/followup?lang=en",
    );
    expect(upstreamInit.method).toBe("POST");

    const headers = upstreamInit.headers as Headers;
    expect(headers.get("X-Mukoko-User-Id")).toBe("user_abc");
    expect(headers.get("X-Mukoko-User-Email")).toBe("bryan@nyuchi.com");
    // Cookies must be stripped so the Python layer never sees the session cookie.
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("mirrors upstream status code to the client", async () => {
    withAuthMock.mockResolvedValueOnce({ user: { id: "u1", email: "a@b.c" } });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "rate limited" }), {
        status: 429,
        headers: { "retry-after": "60" },
      }),
    );

    const mod = await import("./route");
    const params = Promise.resolve({ path: ["followup"] });
    const req = makeRequest("https://weather.mukoko.com/api/ai/followup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "?" }),
    });
    const res = await mod.POST(req as never, { params });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });

  it("exposes GET/POST/PUT/PATCH/DELETE/OPTIONS exports", async () => {
    const mod = await import("./route");
    expect(typeof mod.GET).toBe("function");
    expect(typeof mod.POST).toBe("function");
    expect(typeof mod.PUT).toBe("function");
    expect(typeof mod.PATCH).toBe("function");
    expect(typeof mod.DELETE).toBe("function");
    expect(typeof mod.OPTIONS).toBe("function");
  });
});
