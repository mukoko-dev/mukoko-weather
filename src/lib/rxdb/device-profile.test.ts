import { describe, it, expect, vi } from "vitest";
import {
  createDeviceProfileClient,
  DEVICE_SYNC_BACKOFF_BASE_MS,
  DEVICE_SYNC_BACKOFF_MAX_MS,
  type DevicePrefsBody,
} from "./device-profile";

const ID = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const PREFS: DevicePrefsBody = {
  theme: "dark",
  selectedLocation: "harare",
  savedLocations: ["nairobi-ke"],
  locationLabels: {},
  selectedActivities: ["braai"],
  hasOnboarded: true,
  selectedForecastModel: "best_match",
};

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** A fake Worker: replies come from a script, calls are recorded. */
function fakeWorker(
  script: (call: Call, n: number) => Response | Promise<Response> | Error,
) {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const out = script(call, calls.length);
    if (out instanceof Error) throw out;
    return out;
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function client(fetcher: typeof fetch, clock = { t: 1_000_000 }) {
  return {
    clock,
    c: createDeviceProfileClient({
      deviceId: ID,
      fetcher,
      now: () => clock.t,
      localPrefs: async () => PREFS,
    }),
  };
}

describe("device profile sync: a profile the Worker does not hold", () => {
  it("pull: a 404 creates the profile once with the caller's deviceId and the local preferences", async () => {
    const w = fakeWorker((call) =>
      call.method === "GET"
        ? json(404, { error: "not_found" })
        : json(201, { deviceId: ID }),
    );
    const { c } = client(w.fetcher);

    const pulled = await c.pull();

    expect(pulled).toBeNull(); // nothing to apply: the server now equals local
    expect(w.calls.map((x) => x.method)).toEqual(["GET", "POST"]);
    expect(w.calls[1].url).toMatch(/\/v1\/devices$/);
    expect(w.calls[1].body).toEqual({
      deviceId: ID,
      preferences: expect.objectContaining({
        theme: "dark",
        selectedLocation: "harare",
        savedLocations: ["nairobi-ke"],
      }),
    });
  });

  it("push: PATCH 404 then POST 201 delivers the preferences in the create and does not loop", async () => {
    const w = fakeWorker((call) =>
      call.method === "PATCH" ? json(404) : json(201, { deviceId: ID }),
    );
    const { c } = client(w.fetcher);

    await expect(c.push(PREFS)).resolves.toBeUndefined();

    expect(w.calls.map((x) => x.method)).toEqual(["PATCH", "POST"]);
    expect(w.calls[0].url).toMatch(new RegExp(`/v1/devices/${ID}$`));
    expect((w.calls[1].body as { deviceId: string }).deviceId).toBe(ID);
  });

  it("after the create, the next push is a plain PATCH and the next pull a plain GET", async () => {
    let created = false;
    const w = fakeWorker((call) => {
      if (call.method === "POST") {
        created = true;
        return json(201);
      }
      if (!created) return json(404);
      return call.method === "GET"
        ? json(200, { preferences: { theme: "dark" } })
        : json(200);
    });
    const { c } = client(w.fetcher);

    await c.push(PREFS); // PATCH 404, POST 201
    await c.push(PREFS); // PATCH 200
    const pulled = await c.pull(); // GET 200

    expect(w.calls.map((x) => x.method)).toEqual([
      "PATCH",
      "POST",
      "PATCH",
      "GET",
    ]);
    expect(pulled).toEqual({ preferences: { theme: "dark" } });
  });

  it("404 twice (the profile is still missing right after a 201): one create, then local-only for the session", async () => {
    const w = fakeWorker((call) =>
      call.method === "POST" ? json(201) : json(404),
    );
    const { c } = client(w.fetcher);

    await c.push(PREFS); // PATCH 404, POST 201
    await c.push(PREFS); // PATCH 404 again: no second create
    await c.push(PREFS); // gave up: not even a PATCH
    expect(await c.pull()).toBeNull();

    expect(w.calls.filter((x) => x.method === "POST")).toHaveLength(1);
    expect(w.calls).toHaveLength(3); // PATCH, POST, PATCH
  });

  it("two requests that both meet a 404 at once share one create", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = fakeWorker((call) => {
      if (call.method === "POST") return gate.then(() => json(201)) as never;
      return json(404);
    });
    const { c } = client(w.fetcher);

    const both = Promise.all([c.pull(), c.push(PREFS)]);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    release();
    await both;

    expect(w.calls.filter((x) => x.method === "POST")).toHaveLength(1);
  });

  it("creation fails (500): push asks to be retried, and nothing more is sent until the back-off ends", async () => {
    const w = fakeWorker((call) =>
      call.method === "POST" ? json(500) : json(404),
    );
    const { c, clock } = client(w.fetcher);

    await expect(c.push(PREFS)).rejects.toThrow();
    const sent = w.calls.length; // PATCH + POST
    expect(sent).toBe(2);

    // RxDB retries every 5 s; inside the back-off these cost no request.
    for (let i = 0; i < 20; i++) {
      clock.t += 1_000;
      await expect(c.push(PREFS)).rejects.toThrow();
      expect(await c.pull()).toBeNull();
    }
    expect(w.calls).toHaveLength(sent);

    // After the back-off it tries again.
    clock.t += DEVICE_SYNC_BACKOFF_BASE_MS;
    await expect(c.push(PREFS)).rejects.toThrow();
    expect(w.calls.length).toBeGreaterThan(sent);
  });

  it("the back-off doubles on repeated failure and is capped", async () => {
    const w = fakeWorker(() => json(503));
    const { c, clock } = client(w.fetcher);

    const waits: number[] = [];
    for (let i = 0; i < 12; i++) {
      await expect(c.push(PREFS)).rejects.toThrow();
      const { blockedUntil } = c.state();
      waits.push(blockedUntil - clock.t);
      clock.t = blockedUntil; // the back-off has just ended
    }
    expect(waits[0]).toBe(DEVICE_SYNC_BACKOFF_BASE_MS);
    expect(waits[1]).toBe(DEVICE_SYNC_BACKOFF_BASE_MS * 2);
    expect(waits[2]).toBe(DEVICE_SYNC_BACKOFF_BASE_MS * 4);
    expect(Math.max(...waits)).toBe(DEVICE_SYNC_BACKOFF_MAX_MS);
    expect(waits.at(-1)).toBe(DEVICE_SYNC_BACKOFF_MAX_MS);
  });

  it("a success clears the back-off", async () => {
    let ok = false;
    const w = fakeWorker(() => (ok ? json(200) : json(503)));
    const { c, clock } = client(w.fetcher);
    await expect(c.push(PREFS)).rejects.toThrow();
    clock.t = c.state().blockedUntil;
    ok = true;
    await c.push(PREFS);
    expect(c.state()).toMatchObject({ failures: 0, blockedUntil: 0 });
  });

  it("offline: a rejected fetch makes push retry later and pull return nothing, without a request storm", async () => {
    const w = fakeWorker(() => new TypeError("Failed to fetch"));
    const { c, clock } = client(w.fetcher);

    await expect(c.push(PREFS)).rejects.toThrow();
    expect(await c.pull()).toBeNull();
    for (let i = 0; i < 30; i++) {
      clock.t += 500;
      await expect(c.push(PREFS)).rejects.toThrow();
      expect(await c.pull()).toBeNull();
    }
    expect(w.calls).toHaveLength(1);
  });

  it("a 429 or 5xx on a PATCH is transient: retry later; a 400 is dropped without creating anything", async () => {
    const w = fakeWorker(() => json(400, { error: "invalid_request" }));
    const { c } = client(w.fetcher);
    await expect(c.push(PREFS)).resolves.toBeUndefined();
    expect(w.calls.map((x) => x.method)).toEqual(["PATCH"]);

    const w2 = fakeWorker(() => json(429));
    const { c: c2 } = client(w2.fetcher);
    await expect(c2.push(PREFS)).rejects.toThrow();
    expect(w2.calls.map((x) => x.method)).toEqual(["PATCH"]);
  });

  it("a healthy profile: pull returns it, push is one PATCH, no create", async () => {
    const w = fakeWorker((call) =>
      call.method === "GET"
        ? json(200, { preferences: { theme: "light" } })
        : json(200),
    );
    const { c } = client(w.fetcher);
    expect(await c.pull()).toEqual({ preferences: { theme: "light" } });
    await c.push(PREFS);
    expect(w.calls.map((x) => x.method)).toEqual(["GET", "PATCH"]);
  });

  it("a malformed device id is refused before any request", () => {
    const w = fakeWorker(() => json(200));
    expect(() =>
      createDeviceProfileClient({ deviceId: "../etc", fetcher: w.fetcher }),
    ).toThrow(/Invalid device ID/);
    expect(w.calls).toHaveLength(0);
  });

  it("is silent: a 404, a create, a refusal and being offline write nothing to the console", async () => {
    const spies = (["log", "warn", "error", "info", "debug"] as const).map(
      (m) => vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const scenarios: Array<(call: Call) => Response | Error> = [
      (call) => (call.method === "POST" ? json(201) : json(404)),
      (call) => (call.method === "POST" ? json(500) : json(404)),
      () => new TypeError("Failed to fetch"),
      () => json(429),
    ];
    for (const script of scenarios) {
      const w = fakeWorker((call) => script(call));
      const { c } = client(w.fetcher);
      await c.pull();
      await c.push(PREFS).catch(() => undefined);
    }
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it("never blocks the caller: pull resolves even when the create itself fails", async () => {
    const w = fakeWorker((call) =>
      call.method === "POST" ? new TypeError("Failed to fetch") : json(404),
    );
    const { c } = client(w.fetcher);
    await expect(c.pull()).resolves.toBeNull();
  });

  it("a create the Worker refuses for good (400) settles local-only: no endless retry", async () => {
    const w = fakeWorker((call) =>
      call.method === "POST"
        ? json(400, { error: "invalid_request" })
        : json(404),
    );
    const { c, clock } = client(w.fetcher);

    await expect(c.push(PREFS)).resolves.toBeUndefined(); // dropped, not retried
    expect(c.state().localOnly).toBe(true);
    const sent = w.calls.length;
    for (let i = 0; i < 10; i++) {
      clock.t += 60 * 60_000;
      await expect(c.push(PREFS)).resolves.toBeUndefined();
      expect(await c.pull()).toBeNull();
    }
    expect(w.calls).toHaveLength(sent);
  });

  it("a 429 on the create is transient, not a refusal", async () => {
    const w = fakeWorker((call) =>
      call.method === "POST" ? json(429) : json(404),
    );
    const { c } = client(w.fetcher);
    await expect(c.push(PREFS)).rejects.toThrow();
    expect(c.state().localOnly).toBe(false);
  });
});
