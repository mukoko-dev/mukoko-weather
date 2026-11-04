/**
 * /api/profile/preferences with the switches ON: signed-in only, the person
 * comes from the session and nowhere else, same-origin JSON for PUT, per-person
 * limits, strict validation with fixed problem answers, and no value of the
 * request in any answer or log. Storage is mocked: the route names none.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const flags = vi.hoisted(() => ({ ready: true, places: false }));
vi.mock("@/lib/person-preferences-switches", () => ({
  get PERSON_PREFERENCES_READY() {
    return flags.ready;
  },
  get PERSON_SAVED_PLACES_READY() {
    return flags.places;
  },
}));

const withAuthMock = vi.hoisted(() => vi.fn());
vi.mock("@workos-inc/authkit-nextjs", () => ({ withAuth: withAuthMock }));

const rateLimitMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/user-rate-limit", () => ({ checkUserRateLimit: rateLimitMock }));

const logWarnMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/observability", () => ({
  logWarn: logWarnMock,
  logError: vi.fn(),
}));

const store = vi.hoisted(() => ({ read: vi.fn(), merge: vi.fn() }));
vi.mock("@/lib/person-preferences-store", () => ({
  personPreferencesStore: store,
}));

import { GET, PUT } from "./route";
import { MAX_BODY_BYTES, MAX_CLOCK_AHEAD_MS } from "@/lib/person-preferences";
import {
  ACT,
  ACT2,
  T1,
  T2,
  activity,
  envelopeFor,
  place,
} from "@/lib/person-preferences-fixtures";

const SITE = "https://weather.mukoko.com";
const URL = `${SITE}/api/profile/preferences`;
const JSON_ORIGIN = { "content-type": "application/json", origin: SITE };

const put = (body: unknown, headers: Record<string, string> = JSON_ORIGIN) =>
  new Request(URL, {
    method: "PUT",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as never;

async function json(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

const empty = { activities: [], savedPlaces: [] };

beforeEach(() => {
  for (const m of [
    withAuthMock,
    rateLimitMock,
    logWarnMock,
    store.read,
    store.merge,
  ]) {
    m.mockReset();
  }
  flags.ready = true;
  flags.places = false;
  withAuthMock.mockResolvedValue({ user: { id: "user_1" } });
  rateLimitMock.mockResolvedValue({ allowed: true });
  store.read.mockResolvedValue(empty);
  store.merge.mockResolvedValue({ kind: "ok", stored: empty });
});

describe("GET", () => {
  it("is 401 for an anonymous caller and touches nothing", async () => {
    withAuthMock.mockResolvedValue({ user: null });
    const res = await GET();
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(store.read).not.toHaveBeenCalled();
  });

  it("is 401 when AuthKit cannot say who (a path it skipped)", async () => {
    withAuthMock.mockRejectedValue(new Error("no auth headers"));
    expect((await GET()).status).toBe(401);
  });

  it("answers the empty person of the contract", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      schemaVersion: "v3.1",
      settings: {},
      activities: [],
      savedPlaces: [],
    });
  });

  it("reads the SESSION's person, whatever the request says", async () => {
    store.read.mockResolvedValue(empty);
    await GET();
    expect(store.read).toHaveBeenCalledWith("user_1");
    // GET takes no argument at all: there is nothing in the request to read.
    expect(GET.length).toBe(0);
  });

  it("returns tombstones and the latest updatedAt, ordered", async () => {
    store.read.mockResolvedValue({
      activities: [
        activity({ activityId: ACT2, updatedAt: T2, tombstone: true }),
        activity({ activityId: ACT, updatedAt: T1 }),
      ],
      savedPlaces: [],
    });
    const body = await json(await GET());
    expect(body.updatedAt).toBe(T2);
    expect(
      (body.activities as { tombstone: boolean }[])
        .map((a) => a.tombstone)
        .sort(),
    ).toEqual([false, true]);
  });

  it("does not return saved places while their switch is off", async () => {
    store.read.mockResolvedValue({ activities: [], savedPlaces: [place()] });
    expect((await json(await GET())).savedPlaces).toEqual([]);
    flags.places = true;
    expect((await json(await GET())).savedPlaces).toEqual([place()]);
  });

  it("is private and never cached", async () => {
    expect((await GET()).headers.get("cache-control")).toBe(
      "private, no-store",
    );
  });

  it("is limited per person: 60 a minute", async () => {
    await GET();
    expect(rateLimitMock).toHaveBeenCalledWith(
      "person-prefs-read",
      "user_1",
      60,
      60,
    );
    rateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 17 });
    const res = await GET();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
    expect(store.read).toHaveBeenCalledTimes(1);
  });

  it("is 404 when the person has no record", async () => {
    store.read.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(404);
    expect((await json(res)).code).toBe("person_not_found");
  });

  it("is a 503 with a retry hint when storage fails, and logs no value", async () => {
    store.read.mockRejectedValue(
      Object.assign(new Error("scheme://user:secret@host/db failed"), {
        name: "StoreError",
      }),
    );
    const res = await GET();
    expect(res.status).toBe(503);
    expect((await json(res)).code).toBe("store_unavailable");
    expect(res.headers.get("retry-after")).toBe("30");
    const logged = JSON.stringify(logWarnMock.mock.calls);
    expect(logged).toContain("StoreError");
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain("scheme://");
  });
});

describe("PUT: the gates", () => {
  it("is 415 without application/json and 403 from another origin or none", async () => {
    expect(
      (await PUT(put({}, { "content-type": "text/plain", origin: SITE })))
        .status,
    ).toBe(415);
    expect(
      (
        await PUT(
          put(
            {},
            {
              "content-type": "application/json",
              origin: "https://evil.example",
            },
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (await PUT(put({}, { "content-type": "application/json" }))).status,
    ).toBe(403);
    expect(
      (
        await PUT(
          put({}, { "content-type": "application/json", origin: "null" }),
        )
      ).status,
    ).toBe(403);
    expect(store.merge).not.toHaveBeenCalled();
    expect(rateLimitMock).not.toHaveBeenCalled();
  });

  it("is 401 for an anonymous caller", async () => {
    withAuthMock.mockResolvedValue({ user: null });
    const res = await PUT(put({ activities: [activity()] }));
    expect(res.status).toBe(401);
    expect(store.merge).not.toHaveBeenCalled();
  });

  it("is limited per person: 30 a minute", async () => {
    await PUT(put({}));
    expect(rateLimitMock).toHaveBeenCalledWith(
      "person-prefs-write",
      "user_1",
      30,
      60,
    );
    rateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 5 });
    const res = await PUT(put({ activities: [activity()] }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(store.merge).toHaveBeenCalledTimes(1);
  });

  it("is 413 for a body over 16 KiB, by header or by content", async () => {
    const big = "x".repeat(MAX_BODY_BYTES + 1);
    const byContent = await PUT(put(JSON.stringify({ pad: big })));
    expect(byContent.status).toBe(413);
    const declared = new Request(URL, {
      method: "PUT",
      headers: { ...JSON_ORIGIN, "content-length": String(MAX_BODY_BYTES + 1) },
      body: "{}",
    }) as never;
    expect((await PUT(declared)).status).toBe(413);
    expect(store.merge).not.toHaveBeenCalled();
  });

  it("cuts off a body that does not declare its length once it passes the limit", async () => {
    let pulled = 0;
    let cancelled = false;
    const chunk = new TextEncoder().encode("x".repeat(4_096));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const req = new Request(URL, {
      method: "PUT",
      headers: JSON_ORIGIN,
      body: stream,
      // Required by Node for a streamed request body.
      duplex: "half",
    } as RequestInit) as never;
    const res = await PUT(req);
    expect(res.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(pulled * 4_096).toBeLessThan(MAX_BODY_BYTES * 3);
    expect(store.merge).not.toHaveBeenCalled();
  });

  it("is 400 for a body that is not JSON", async () => {
    const res = await PUT(put("{not json"));
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("invalid_json");
  });
});

describe("PUT: validation (nothing is applied on any refusal)", () => {
  const refused = async (body: unknown, status: number, code: string) => {
    const res = await PUT(put(body));
    expect(res.status).toBe(status);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect((await json(res)).code).toBe(code);
    expect(store.merge).not.toHaveBeenCalled();
  };

  it("refuses a person id in the body: the person is the session", async () => {
    await refused({ userId: "user_2", activities: [] }, 422, "unknown_field");
    await refused({ personId: "p2" }, 422, "unknown_field");
  });

  it("refuses an activity that is not in the catalogue, and bad forms", async () => {
    await refused(
      { activities: [activity({ activityId: "ghost" })] },
      422,
      "activity_not_allowed",
    );
    await refused(
      { activities: [{ activityId: ACT }] },
      422,
      "invalid_activity",
    );
  });

  it("refuses an updatedAt more than a day ahead", async () => {
    const ahead = new Date(
      Date.now() + MAX_CLOCK_AHEAD_MS + 60_000,
    ).toISOString();
    await refused(
      { activities: [activity({ updatedAt: ahead })] },
      422,
      "updated_at_in_future",
    );
  });

  it("refuses settings", async () => {
    await refused(
      { settings: { theme: { value: "dark", updatedAt: T1 } } },
      422,
      "settings_not_supported",
    );
  });

  it("answers with fixed text and never echoes the request", async () => {
    const res = await PUT(
      put({ activities: [activity({ activityId: "SECRET-ID" })] }),
    );
    expect(JSON.stringify(await json(res))).not.toContain("SECRET-ID");
  });

  it("answers RFC 9457 problems", async () => {
    const body = await json(await PUT(put({ nope: 1 })));
    expect(body).toMatchObject({
      type: "about:blank",
      title: "Unprocessable Content",
      status: 422,
      code: "unknown_field",
    });
    expect(typeof body.detail).toBe("string");
  });
});

describe("PUT: merging", () => {
  it("merges for the SESSION's person and answers the merged whole", async () => {
    const mergedStored = {
      activities: [activity({ activityId: ACT, updatedAt: T2 })],
      savedPlaces: [],
    };
    store.merge.mockResolvedValue({ kind: "ok", stored: mergedStored });
    const res = await PUT(
      put({ activities: [activity({ activityId: ACT, updatedAt: T2 })] }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const [who, patch, at] = store.merge.mock.calls[0];
    expect(who).toBe("user_1");
    expect(patch.activities).toEqual([
      activity({ activityId: ACT, updatedAt: T2 }),
    ]);
    expect(at).toBeInstanceOf(Date);
    expect(await json(res)).toEqual({
      schemaVersion: "v3.1",
      settings: {},
      activities: mergedStored.activities,
      savedPlaces: [],
      updatedAt: T2,
    });
  });

  it("takes a subset: an empty body is a no-op that still answers the document", async () => {
    const res = await PUT(put({}));
    expect(res.status).toBe(200);
    expect(store.merge.mock.calls[0][1]).toEqual(empty);
  });

  it("answers what the store refuses (a cap) as its problem, applying nothing", async () => {
    store.merge.mockResolvedValue({
      kind: "refused",
      problem: { status: 422, code: "too_many_activities" },
    });
    const res = await PUT(put({ activities: [activity()] }));
    expect(res.status).toBe(422);
    expect((await json(res)).code).toBe("too_many_activities");
  });

  it("is 404 when the person has no record", async () => {
    store.merge.mockResolvedValue({ kind: "no_person" });
    expect((await PUT(put({ activities: [activity()] }))).status).toBe(404);
  });

  it("is a 503 with a retry hint when storage fails, and logs no value", async () => {
    store.merge.mockRejectedValue(new Error(`failed for ${ACT}`));
    const res = await PUT(put({ activities: [activity()] }));
    expect(res.status).toBe(503);
    expect((await json(res)).code).toBe("store_unavailable");
    expect(JSON.stringify(logWarnMock.mock.calls)).not.toContain(ACT);
  });
});

describe("PUT: saved places have their own switch", () => {
  const body = { savedPlaces: [place()] };

  it("is 503 saved_places_unavailable while it is off, applying nothing", async () => {
    const res = await PUT(put(body));
    expect(res.status).toBe(503);
    expect((await json(res)).code).toBe("saved_places_unavailable");
    expect(store.merge).not.toHaveBeenCalled();
  });

  it("still takes activities while saved places are off", async () => {
    expect((await PUT(put({ activities: [activity()] }))).status).toBe(200);
  });

  it("takes only ciphertext when it is on", async () => {
    flags.places = true;
    store.merge.mockResolvedValue({
      kind: "ok",
      stored: { activities: [], savedPlaces: [place()] },
    });
    expect((await PUT(put(body))).status).toBe(200);
    expect(store.merge).toHaveBeenCalledTimes(1);

    const readable = { savedPlaces: [{ ...place(), place: "nairobi-ke" }] };
    expect((await PUT(put(readable))).status).toBe(422);
    const badAad = {
      savedPlaces: [
        place({
          envelope: envelopeFor("01934f6a-7b2c-7d3e-8a4f-000000000009"),
        }),
      ],
    };
    expect((await PUT(put(badAad))).status).toBe(422);
    expect(store.merge).toHaveBeenCalledTimes(1);
  });
});
