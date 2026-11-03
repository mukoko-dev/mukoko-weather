import { describe, expect, it, vi } from "vitest";
import {
  CouchSessionError,
  ensurePersonalDatabase,
  fetchCouchSession,
  parseApiOrigin,
  parseSessionBody,
  personalDatabaseUrl,
} from "./couch-session";
import { CouchHttpError } from "./couch-fetch";

const PERSON = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const good = {
  token: "a-credential-longer-than-sixteen",
  expiresAt: "2026-11-02T10:10:00.000Z",
  database: `user_${PERSON}`,
  apiOrigin: "https://api.nyuchi.com",
};

const reply = (status: number, body: unknown) =>
  vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;

describe("parseSessionBody", () => {
  it("builds the database URL under the API host and reads the person", () => {
    const s = parseSessionBody(good);
    expect(s.databaseUrl).toBe(
      `https://api.nyuchi.com/v1/couch/db/user_${PERSON}/`,
    );
    expect(s.personId).toBe(PERSON);
    expect(s.expiresAtMs).toBe(Date.parse(good.expiresAt));
    expect(s.token).toBe(good.token);
  });

  it("refuses anything that is not exactly the documented shape", () => {
    const bad: unknown[] = [
      null,
      "x",
      {},
      { ...good, token: "short" },
      { ...good, token: 7 },
      { ...good, expiresAt: "tomorrow" },
      { ...good, database: "family_x" },
      { ...good, database: `user_${PERSON}/../x` },
      { ...good, apiOrigin: "http://api.nyuchi.com" },
      { ...good, apiOrigin: "https://api.nyuchi.com/v1" },
      { ...good, apiOrigin: "https://u:p@api.nyuchi.com" },
      { ...good, apiOrigin: "javascript:alert(1)" },
    ];
    for (const b of bad) {
      expect(() => parseSessionBody(b), JSON.stringify(b)).toThrow(
        CouchSessionError,
      );
    }
  });

  it("accepts plain http only for localhost", () => {
    expect(parseApiOrigin("http://localhost:8000")).toBe(
      "http://localhost:8000",
    );
    expect(parseApiOrigin("http://example.com")).toBeNull();
  });
});

describe("fetchCouchSession", () => {
  it("posts JSON to the same-origin route with cookies and no cache", async () => {
    const f = reply(200, good);
    await fetchCouchSession(f);
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe("/api/couch/session");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.cache).toBe("no-store");
    expect(new Headers(init.headers).get("content-type")).toBe(
      "application/json",
    );
  });

  it("a refusal carries the status and the route's code", async () => {
    await expect(
      fetchCouchSession(reply(401, { error: "unauthorized" })),
    ).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    await expect(
      fetchCouchSession(reply(503, { error: "couch_unavailable" })),
    ).rejects.toMatchObject({ status: 503, code: "couch_unavailable" });
    await expect(fetchCouchSession(reply(404, {}))).rejects.toMatchObject({
      status: 404,
      code: "unavailable",
    });
  });

  it("an unreadable code is replaced, never echoed", async () => {
    await expect(
      fetchCouchSession(reply(500, { error: "<script>alert(1)</script>" })),
    ).rejects.toMatchObject({ status: 500, code: "unavailable" });
  });

  it("no answer is status 0", async () => {
    const offline = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    await expect(fetchCouchSession(offline)).rejects.toMatchObject({
      status: 0,
      code: "offline",
    });
  });
});

describe("ensurePersonalDatabase", () => {
  const session = parseSessionBody(good);
  const ready = {
    person_id: PERSON,
    database: `user_${PERSON}`,
    ready: true,
  };

  it("posts to the gateway's personal route on the API host with the grant as the bearer and nothing else", async () => {
    const f = reply(200, ready);
    await ensurePersonalDatabase(session, f);
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.nyuchi.com/v1/couch/personal");
    expect(personalDatabaseUrl(session)).toBe(url);
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(init.credentials).toBe("omit");
    expect(init.cache).toBe("no-store");
    expect(init.redirect).toBe("error");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${good.token}`);
    expect([...headers.keys()].sort()).toEqual(["accept", "authorization"]);
  });

  it("is on the same origin as the database, whatever the origin is", () => {
    const local = parseSessionBody({
      ...good,
      apiOrigin: "http://localhost:8000",
    });
    expect(personalDatabaseUrl(local)).toBe(
      "http://localhost:8000/v1/couch/personal",
    );
  });

  it("a refusal is a CouchHttpError with the status the engine backs off on", async () => {
    for (const status of [401, 403, 429, 503]) {
      await expect(
        ensurePersonalDatabase(session, reply(status, { detail: "x" })),
      ).rejects.toMatchObject({ name: "CouchHttpError", status });
    }
  });

  it("no answer is status 0, and the token is in no error", async () => {
    const offline = (async () => {
      throw new TypeError(`Failed to fetch ${good.token}`);
    }) as typeof fetch;
    const err = await ensurePersonalDatabase(session, offline).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CouchHttpError);
    expect((err as CouchHttpError).status).toBe(0);
    expect(String((err as Error).message)).not.toContain(good.token);
  });

  it("an answer that is not 'ready' for this very database is a 502", async () => {
    const bad: unknown[] = [
      {},
      "ready",
      null,
      { ...ready, ready: false },
      { ...ready, ready: "true" },
      { ...ready, database: "user_someone-else" },
      { ...ready, person_id: "someone-else" },
    ];
    for (const body of bad) {
      await expect(
        ensurePersonalDatabase(session, reply(200, body)),
        JSON.stringify(body),
      ).rejects.toMatchObject({ status: 502 });
    }
    const notJson = vi.fn(
      async () => new Response("<html>", { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(
      ensurePersonalDatabase(session, notJson),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("a request that takes too long is aborted and is status 0", async () => {
    vi.useFakeTimers();
    try {
      const hangs = ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        })) as unknown as typeof fetch;
      const pending = ensurePersonalDatabase(session, hangs, 1_000).catch(
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      const err = await pending;
      expect(err).toBeInstanceOf(CouchHttpError);
      expect((err as CouchHttpError).status).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
