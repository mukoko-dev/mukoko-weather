import { describe, expect, it, vi } from "vitest";
import {
  CouchSessionError,
  fetchCouchSession,
  parseApiOrigin,
  parseSessionBody,
} from "./couch-session";

const PERSON = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const good = {
  token: "a-credential-longer-than-sixteen",
  expiresAt: "2026-11-02T10:10:00.000Z",
  database: `user_${PERSON}`,
  apiOrigin: "https://api.nyuchi.com",
};

const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

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
    expect(parseApiOrigin("http://localhost:8000")).toBe("http://localhost:8000");
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
