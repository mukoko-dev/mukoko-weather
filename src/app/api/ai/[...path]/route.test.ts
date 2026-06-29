/**
 * Auth-gated AI proxy tests.
 *
 * The proxy MUST:
 *   1. Reject unauthenticated requests with HTTP 401.
 *   2. Forward authenticated requests to /api/py/ai/* with the user's
 *      identity attached as X-Mukoko-User-Id / X-Mukoko-User-Email.
 *   3. Strip cookies/hop-by-hop headers from the upstream request.
 *   4. Pass through method, body, query string, and response status.
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
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Build a minimal NextRequest-shaped object. */
function makeRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: BodyInit } = {},
): Request {
  return new Request(url, {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.body,
  });
}

describe("auth-gated AI proxy", () => {
  it("returns 401 when withAuth() resolves a null user", async () => {
    withAuthMock.mockResolvedValueOnce({ user: null });

    const mod = await import("./route");
    const params = Promise.resolve({ path: ["followup"] });
    const req = makeRequest("https://weather.mukoko.com/api/ai/followup", {
      method: "POST",
    });

    const res = await mod.POST(req as never, { params });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
    // Upstream must NOT be contacted when auth fails.
    expect(fetchMock).not.toHaveBeenCalled();
  });

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
    const req = makeRequest("https://weather.mukoko.com/api/ai/followup?lang=en", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "wos-session=secret" },
      body: JSON.stringify({ message: "hi" }),
    });

    const res = await mod.POST(req as never, { params });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [upstreamUrl, upstreamInit] = fetchMock.mock.calls[0];
    expect(String(upstreamUrl)).toBe("https://weather.mukoko.com/api/py/ai/followup?lang=en");
    expect(upstreamInit.method).toBe("POST");

    const headers = upstreamInit.headers as Headers;
    expect(headers.get("X-Mukoko-User-Id")).toBe("user_abc");
    expect(headers.get("X-Mukoko-User-Email")).toBe("bryan@nyuchi.com");
    // Cookies must be stripped so the Python layer never sees the session cookie.
    expect(headers.get("cookie")).toBeNull();
    // Content-type must survive.
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("forwards GET requests without a body and preserves the query string", async () => {
    withAuthMock.mockResolvedValueOnce({
      user: { id: "user_xyz", email: null },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ prompts: [] }), { status: 200 }),
    );

    const mod = await import("./route");
    const params = Promise.resolve({ path: ["prompts"] });
    const req = makeRequest("https://weather.mukoko.com/api/ai/prompts?key=foo", {
      method: "GET",
    });

    await mod.GET(req as never, { params });
    const [upstreamUrl, upstreamInit] = fetchMock.mock.calls[0];
    expect(String(upstreamUrl)).toBe("https://weather.mukoko.com/api/py/ai/prompts?key=foo");
    expect(upstreamInit.method).toBe("GET");
    expect(upstreamInit.body).toBeUndefined();
    const headers = upstreamInit.headers as Headers;
    expect(headers.get("X-Mukoko-User-Id")).toBe("user_xyz");
    // No email — header must not be set.
    expect(headers.get("X-Mukoko-User-Email")).toBeNull();
  });

  it("supports nested subpaths (suggested-rules, deep paths)", async () => {
    withAuthMock.mockResolvedValueOnce({ user: { id: "u1", email: "a@b.c" } });
    fetchMock.mockResolvedValueOnce(new Response("[]", { status: 200 }));

    const mod = await import("./route");
    const params = Promise.resolve({ path: ["suggested-rules"] });
    const req = makeRequest("https://weather.mukoko.com/api/ai/suggested-rules");
    await mod.GET(req as never, { params });

    const [upstreamUrl] = fetchMock.mock.calls[0];
    expect(String(upstreamUrl)).toBe("https://weather.mukoko.com/api/py/ai/suggested-rules");
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
