/**
 * The browser side of "activities follow the person": the merge rules, the
 * cross-person guard, and the retry schedule, against a fake server that
 * applies the contract's own merge. No network, no storage, no clock.
 */
import { describe, it, expect, vi } from "vitest";
import { ACTIVITIES, getActivityById } from "./activities";
import {
  MAX_PERSON_ACTIVITIES,
  capProblem,
  mergeById,
  toDocument,
  activityIdOf,
  type ActivityItem,
} from "./person-preferences";
import {
  SYNC_BACKOFF_MAX_MS,
  SYNC_DEBOUNCE_MS,
  backoffMs,
  createPersonSyncController,
  projectLocal,
  reconcile,
  syncOnce,
  type Scheduler,
  type SyncDeps,
  type SyncOutcome,
  type SyncState,
} from "./person-preferences-sync";
import {
  ACT,
  ACT2,
  ACT3,
  T1,
  T2,
  T3,
  activity,
} from "./person-preferences-fixtures";

const NOW_MS = Date.parse("2026-11-04T12:00:00.000Z");
const NOW = new Date(NOW_MS).toISOString();
const ME = "user_me";
const OTHER = "user_other";

// --- fakes --------------------------------------------------------------------

type Handler = (
  method: string,
  body: unknown,
) => Response | Promise<Response> | undefined;

/** A server holding one person's activities, merging like the real one. */
function fakeServer(initial: ActivityItem[] = [], intercept?: Handler) {
  let items = initial;
  const calls: { method: string; body: unknown }[] = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const method = String(init.method);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, body });
    const custom = await intercept?.(method, body);
    if (custom) return custom;
    if (method === "PUT") {
      const merged = mergeById(items, body.activities ?? [], activityIdOf);
      const problem = capProblem(
        { activities: items, savedPlaces: [] },
        { activities: merged, savedPlaces: [] },
      );
      if (problem) {
        return Response.json(
          { code: problem.code },
          { status: problem.status },
        );
      }
      items = merged;
    }
    return Response.json(toDocument(items, []));
  });
  return {
    fetch: fetch as unknown as SyncDeps["fetch"],
    spy: fetch,
    calls,
    get items() {
      return items;
    },
    puts: () => calls.filter((c) => c.method === "PUT"),
  };
}

function device(
  owner: string,
  local: string[],
  state: SyncState | null,
  server: ReturnType<typeof fakeServer>,
) {
  let current = [...local];
  let saved = state;
  const writes: SyncState[] = [];
  const deps: SyncDeps = {
    ownerId: owner,
    now: () => NOW_MS,
    readLocal: () => current,
    applyLocal: (ids) => {
      current = [...ids];
    },
    readState: () => saved,
    writeState: (s) => {
      saved = s;
      writes.push(s);
    },
    isKnownActivity: (id) => getActivityById(id) !== undefined,
    fetch: server.fetch,
  };
  return {
    deps,
    get local() {
      return current;
    },
    set local(v: string[]) {
      current = v;
    },
    get state() {
      return saved;
    },
    writes,
  };
}

const live = (items: ActivityItem[]) =>
  items.filter((i) => !i.tombstone).map((i) => i.activityId);
const byId = (items: ActivityItem[], id: string) =>
  items.find((i) => i.activityId === id);

// --- first sign-in on a device ----------------------------------------------

describe("first sign-in on a device", () => {
  it("sends the device's activities to an empty profile and keeps the device as it is", async () => {
    const server = fakeServer();
    const d = device(ME, [ACT, ACT2], null, server);
    expect(await syncOnce(d.deps, { first: true })).toEqual({ kind: "synced" });
    expect(live(server.items).sort()).toEqual([ACT, ACT2].sort());
    expect(d.local).toEqual([ACT, ACT2]);
    expect(d.state?.owner).toBe(ME);
    expect(server.puts()).toHaveLength(1);
    expect(server.puts()[0].body).toEqual({
      activities: [
        { activityId: ACT, createdAt: NOW, updatedAt: NOW, tombstone: false },
        { activityId: ACT2, createdAt: NOW, updatedAt: NOW, tombstone: false },
      ],
    });
  });

  it("brings the profile's activities to the device and sends only what is new", async () => {
    const server = fakeServer([activity({ activityId: ACT3 })]);
    const d = device(ME, [ACT], null, server);
    await syncOnce(d.deps, { first: true });
    expect(d.local).toEqual([ACT, ACT3]);
    expect(live(server.items).sort()).toEqual([ACT, ACT3].sort());
    const sent = (server.puts()[0].body as { activities: ActivityItem[] })
      .activities;
    expect(sent.map((a) => a.activityId)).toEqual([ACT]);
  });

  it("never empties the device because the profile is empty", async () => {
    const server = fakeServer([]);
    const d = device(ME, [ACT, ACT2], null, server);
    await syncOnce(d.deps, { first: true });
    expect(d.local).toEqual([ACT, ACT2]);
  });

  it("never empties the profile because the device is empty, and sends nothing", async () => {
    const server = fakeServer([activity({ activityId: ACT })]);
    const d = device(ME, [], null, server);
    await syncOnce(d.deps, { first: true });
    expect(server.puts()).toHaveLength(0);
    expect(d.local).toEqual([ACT]);
    expect(live(server.items)).toEqual([ACT]);
  });

  it("keeps an item the profile removed removed, for a device with no view of its own", async () => {
    // Nothing on this device saw that removal, so it stands: the profile wins.
    const removed = activity({
      activityId: ACT,
      updatedAt: T2,
      tombstone: true,
    });
    const server = fakeServer([removed]);
    const d = device(ME, [ACT, ACT2], null, server);
    await syncOnce(d.deps, { first: true });
    expect(byId(server.items, ACT)).toMatchObject({
      tombstone: true,
      updatedAt: T2,
    });
    expect(d.local).toEqual([ACT2]);
    expect(live(server.items)).toEqual([ACT2]);
  });

  it("makes no write when there is nothing to send", async () => {
    const server = fakeServer([activity({ activityId: ACT })]);
    const d = device(ME, [ACT], null, server);
    await syncOnce(d.deps, { first: true });
    expect(server.calls.map((c) => c.method)).toEqual(["GET"]);
  });
});

// --- changes after that --------------------------------------------------------

describe("changes between passes", () => {
  const synced = (ids: string[], at = T1): SyncState => ({
    owner: ME,
    activities: ids.map((id) =>
      activity({ activityId: id, createdAt: at, updatedAt: at }),
    ),
  });

  it("sends a removal as a tombstone and keeps it", async () => {
    const server = fakeServer(synced([ACT, ACT2]).activities);
    const d = device(ME, [ACT], synced([ACT, ACT2]), server);
    await syncOnce(d.deps);
    expect(byId(server.items, ACT2)).toMatchObject({
      tombstone: true,
      updatedAt: NOW,
      createdAt: T1,
    });
    expect(d.local).toEqual([ACT]);
    expect(byId(d.state!.activities, ACT2)?.tombstone).toBe(true);
  });

  it("takes a later removal made on another device", async () => {
    const server = fakeServer([
      activity({ activityId: ACT }),
      activity({ activityId: ACT2, updatedAt: T3, tombstone: true }),
    ]);
    const d = device(ME, [ACT, ACT2], synced([ACT, ACT2], T1), server);
    await syncOnce(d.deps);
    expect(d.local).toEqual([ACT]);
    expect(server.puts()).toHaveLength(0);
  });

  it("keeps a removal the server already has no item for out of the request", async () => {
    // Added and removed between two passes: the profile never saw it.
    const server = fakeServer([]);
    const d = device(ME, [ACT], null, server);
    await syncOnce(d.deps, { first: true });
    d.local = [ACT, ACT2];
    d.local = [ACT];
    await syncOnce(d.deps);
    expect(server.puts()).toHaveLength(1);
  });

  it("revives an item the person adds again, keeping its first createdAt", async () => {
    const gone = activity({
      activityId: ACT2,
      createdAt: T1,
      updatedAt: T2,
      tombstone: true,
    });
    const server = fakeServer([gone]);
    const d = device(ME, [ACT2], { owner: ME, activities: [gone] }, server);
    await syncOnce(d.deps);
    expect(byId(server.items, ACT2)).toMatchObject({
      tombstone: false,
      createdAt: T1,
      updatedAt: NOW,
    });
  });

  it("is quiet when nothing changed: one read, no write, no local change", async () => {
    const state = synced([ACT]);
    const server = fakeServer(state.activities);
    const d = device(ME, [ACT], state, server);
    const apply = vi.spyOn(d.deps, "applyLocal");
    await syncOnce(d.deps);
    expect(server.calls.map((c) => c.method)).toEqual(["GET"]);
    expect(apply).not.toHaveBeenCalled();
  });

  it("keeps an edit made on the device while the request was in the air", async () => {
    const server = fakeServer([activity({ activityId: ACT3 })]);
    const d = device(ME, [ACT], synced([ACT]), server);
    const racing = fakeServer([activity({ activityId: ACT3 })], (method) => {
      if (method === "PUT") d.local = [ACT, ACT2];
      return undefined;
    });
    d.deps.fetch = racing.fetch;
    // Make the pass write: ACT is new to the profile.
    d.deps.readState = () => null;
    await syncOnce(d.deps);
    expect(d.local).toEqual(expect.arrayContaining([ACT, ACT2, ACT3]));
  });

  it("does not bring back an item the person removed while the request was in the air", async () => {
    const racing = fakeServer([], (method) => {
      if (method === "PUT") d.local = [ACT];
      return undefined;
    });
    const d = device(ME, [ACT, ACT2], null, racing);
    await syncOnce(d.deps);
    expect(d.local).toEqual([ACT]);
  });
});

// --- another person on the same browser ----------------------------------------

describe("a different person signs in on this browser", () => {
  const previous: SyncState = {
    owner: OTHER,
    activities: [activity({ activityId: ACT }), activity({ activityId: ACT2 })],
  };

  it("does not merge the previous person's selections into their profile", async () => {
    const server = fakeServer([activity({ activityId: ACT3 })]);
    const d = device(ME, [ACT, ACT2], previous, server);
    await syncOnce(d.deps, { first: true });
    expect(server.puts()).toHaveLength(0);
    expect(live(server.items)).toEqual([ACT3]);
  });

  it("shows them their own profile, not the previous person's", async () => {
    const server = fakeServer([activity({ activityId: ACT3 })]);
    const d = device(ME, [ACT, ACT2], previous, server);
    await syncOnce(d.deps, { first: true });
    expect(d.local).toEqual([ACT3]);
  });

  it("leaves the device empty when their profile is empty", async () => {
    const d = device(ME, [ACT, ACT2], previous, fakeServer([]));
    await syncOnce(d.deps, { first: true });
    expect(d.local).toEqual([]);
  });

  it("is now theirs: later passes work as normal for them", async () => {
    const server = fakeServer([activity({ activityId: ACT3 })]);
    const d = device(ME, [ACT, ACT2], previous, server);
    await syncOnce(d.deps, { first: true });
    expect(d.state?.owner).toBe(ME);
    d.local = [ACT3, ACT];
    await syncOnce(d.deps);
    expect(live(server.items).sort()).toEqual([ACT, ACT3].sort());
  });

  it("is the same person again after a sign-out: their view is kept and used", async () => {
    const mine: SyncState = {
      owner: ME,
      activities: [activity({ activityId: ACT })],
    };
    const server = fakeServer(mine.activities);
    const d = device(ME, [ACT, ACT2], mine, server); // added ACT2 while signed out
    await syncOnce(d.deps);
    expect(live(server.items).sort()).toEqual([ACT, ACT2].sort());
  });

  it("treats a device that was never synced as anonymous: its selections are the first person's", async () => {
    const server = fakeServer([]);
    const d = device(ME, [ACT], null, server);
    await syncOnce(d.deps, { first: true });
    expect(live(server.items)).toEqual([ACT]);
  });
});

// --- a view that is too old to vouch for anything --------------------------------

describe("a view older than the tombstone retention (rule 9)", () => {
  const longAgo = new Date(NOW_MS - 40 * 24 * 60 * 60 * 1000).toISOString();
  const recently = new Date(NOW_MS - 24 * 60 * 60 * 1000).toISOString();
  const view = (syncedAt: string | undefined): SyncState => ({
    owner: ME,
    activities: [activity({ activityId: ACT }), activity({ activityId: ACT2 })],
    ...(syncedAt ? { syncedAt } : {}),
  });

  it("does not push back an item the profile no longer has: the removal may have been purged", async () => {
    // ACT2 was removed on another device and its tombstone is gone.
    const server = fakeServer([activity({ activityId: ACT })]);
    const d = device(ME, [ACT, ACT2], view(longAgo), server);
    await syncOnce(d.deps);
    expect(server.puts()).toHaveLength(0);
    expect(live(server.items)).toEqual([ACT]);
    expect(d.local).toEqual([ACT]);
  });

  it("still sends what the person changed since", async () => {
    const server = fakeServer([activity({ activityId: ACT })]);
    const d = device(ME, [ACT, ACT3], view(longAgo), server);
    await syncOnce(d.deps);
    expect(live(server.items).sort()).toEqual([ACT, ACT3].sort());
  });

  it("restores a profile that lost items, when the view is recent (the server does not forget)", async () => {
    const server = fakeServer([]);
    const d = device(ME, [ACT, ACT2], view(recently), server);
    await syncOnce(d.deps);
    expect(live(server.items).sort()).toEqual([ACT, ACT2].sort());
  });

  it("treats a view with no age as recent", async () => {
    const server = fakeServer([]);
    const d = device(ME, [ACT, ACT2], view(undefined), server);
    await syncOnce(d.deps);
    expect(live(server.items).sort()).toEqual([ACT, ACT2].sort());
  });

  it("stamps the view with the time of the pass", async () => {
    const server = fakeServer();
    const d = device(ME, [ACT], null, server);
    await syncOnce(d.deps, { first: true });
    expect(d.state?.syncedAt).toBe(NOW);
  });
});

// --- storage that was lost -----------------------------------------------------

describe("storage lost on the device (Safari's wipe, a private window)", () => {
  const state: SyncState = {
    owner: ME,
    activities: [activity({ activityId: ACT }), activity({ activityId: ACT2 })],
  };

  it("on the first pass, an empty list is not the person removing everything", async () => {
    const server = fakeServer(state.activities);
    const d = device(ME, [], state, server);
    await syncOnce(d.deps, { first: true });
    expect(server.puts()).toHaveLength(0);
    expect(live(server.items).sort()).toEqual([ACT, ACT2].sort());
    expect(d.local.sort()).toEqual([ACT, ACT2].sort());
  });

  it("still restores the profile if the server had lost them too", async () => {
    const server = fakeServer([]);
    const d = device(ME, [], state, server);
    await syncOnce(d.deps, { first: true });
    expect(live(server.items).sort()).toEqual([ACT, ACT2].sort());
  });

  it("on a later pass, emptying the list is a removal", async () => {
    const server = fakeServer(state.activities);
    const d = device(ME, [], state, server);
    await syncOnce(d.deps, { first: false });
    expect(live(server.items)).toEqual([]);
    expect(server.items.every((i) => i.tombstone)).toBe(true);
  });
});

// --- the cap, and ids this app does not know -------------------------------------

describe("the cap and unknown ids", () => {
  it("puts the person's existing items first and sends none of the device's extras over the cap", async () => {
    const existing = ACTIVITIES.slice(3, 3 + MAX_PERSON_ACTIVITIES).map((a) =>
      activity({ activityId: a.id, createdAt: T1, updatedAt: T1 }),
    );
    const server = fakeServer(existing);
    const d = device(ME, [ACT], null, server);
    await syncOnce(d.deps, { first: true });
    expect(server.puts()).toHaveLength(0);
    expect(live(server.items)).toHaveLength(MAX_PERSON_ACTIVITIES);
    expect(d.local).toContain(ACT);
    expect(d.local).toHaveLength(MAX_PERSON_ACTIVITIES + 1);
    expect(byId(d.state!.activities, ACT)).toBeUndefined();
  });

  it("never sends an id the app does not offer, and never applies one it does not know", async () => {
    const server = fakeServer([activity({ activityId: "from-a-newer-app" })]);
    const d = device(ME, ["retired-activity", ACT], null, server);
    await syncOnce(d.deps, { first: true });
    const sent = (server.puts()[0].body as { activities: ActivityItem[] })
      .activities;
    expect(sent.map((a) => a.activityId)).toEqual([ACT]);
    expect(d.local).toEqual(["retired-activity", ACT]);
    expect(byId(d.state!.activities, "from-a-newer-app")).toBeDefined();
  });

  it("does not turn an id from a newer app into a removal on the next pass", async () => {
    const future = activity({ activityId: "from-a-newer-app" });
    const server = fakeServer([future]);
    const d = device(ME, [ACT], null, server);
    await syncOnce(d.deps, { first: true });
    await syncOnce(d.deps);
    expect(byId(server.items, "from-a-newer-app")?.tombstone).toBe(false);
  });

  it("ignores a duplicate in the device list", async () => {
    const server = fakeServer();
    const d = device(ME, [ACT, ACT], null, server);
    await syncOnce(d.deps, { first: true });
    expect(
      (server.puts()[0].body as { activities: unknown[] }).activities,
    ).toHaveLength(1);
  });
});

// --- failures stay quiet and local-first ----------------------------------------

describe("failures", () => {
  const run = async (intercept: Handler | "throw") => {
    const server = fakeServer(
      [],
      intercept === "throw" ? undefined : intercept,
    );
    const d = device(ME, [ACT], null, server);
    if (intercept === "throw") {
      d.deps.fetch = (async () => {
        throw new TypeError("offline");
      }) as never;
    }
    const outcome = await syncOnce(d.deps, { first: true });
    return { outcome, d, server };
  };

  it("offline: retry, and the device is exactly as it was", async () => {
    const { outcome, d } = await run("throw");
    expect(outcome).toEqual({ kind: "retry" });
    expect(d.local).toEqual([ACT]);
    expect(d.writes).toHaveLength(0);
  });

  it("429: retry, waiting for Retry-After", async () => {
    const { outcome } = await run(
      () =>
        new Response("{}", { status: 429, headers: { "retry-after": "12" } }),
    );
    expect(outcome).toEqual({ kind: "retry", afterMs: 12_000 });
  });

  it("429 with no usable Retry-After: plain retry", async () => {
    const { outcome } = await run(() => new Response("{}", { status: 429 }));
    expect(outcome).toEqual({ kind: "retry", afterMs: undefined });
  });

  it("503 preferences_unavailable: stop for the page", async () => {
    const { outcome } = await run(() =>
      Response.json({ code: "preferences_unavailable" }, { status: 503 }),
    );
    expect(outcome).toEqual({
      kind: "stopped",
      reason: "preferences_unavailable",
    });
  });

  it.each([
    [
      "store_unavailable",
      () => Response.json({ code: "store_unavailable" }, { status: 503 }),
    ],
    ["an unreadable 503", () => new Response("<html>", { status: 503 })],
    ["500", () => new Response("", { status: 500 })],
    ["502", () => new Response("", { status: 502 })],
    ["408", () => new Response("", { status: 408 })],
    ["a 200 that is not JSON", () => new Response("<html>", { status: 200 })],
  ])("%s: retry", async (_n, make) => {
    expect((await run(make)).outcome.kind).toBe("retry");
  });

  it("422 (one refused item): retry with the backoff, never silence the sync", async () => {
    const { outcome, d } = await run((method) =>
      method === "PUT"
        ? Response.json({ code: "activity_not_allowed" }, { status: 422 })
        : undefined,
    );
    expect(outcome).toEqual({ kind: "retry" });
    expect(d.writes).toHaveLength(0);
    expect(d.local).toEqual([ACT]);
  });

  it.each([401, 403, 404, 400, 413, 415])(
    "%i: stop for the page",
    async (status) => {
      const { outcome } = await run(() => new Response("{}", { status }));
      expect(outcome).toEqual({ kind: "stopped", reason: String(status) });
    },
  );

  it("a failed write changes nothing on the device and writes no view", async () => {
    const { outcome, d } = await run((method) =>
      method === "PUT" ? new Response("", { status: 500 }) : undefined,
    );
    expect(outcome.kind).toBe("retry");
    expect(d.writes).toHaveLength(0);
    expect(d.local).toEqual([ACT]);
  });

  it("reads only the request it makes: same-origin, no body on a read", async () => {
    const server = fakeServer();
    const d = device(ME, [ACT], null, server);
    await syncOnce(d.deps, { first: true });
    const [get, put] = server.spy.mock.calls;
    expect(get[0]).toBe("/api/profile/preferences");
    expect(get[1]).toMatchObject({ method: "GET", credentials: "same-origin" });
    expect(get[1].body).toBeUndefined();
    expect(put[1]).toMatchObject({
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
    });
  });

  it("never sends a person id, a position, a name or a saved place", async () => {
    const server = fakeServer();
    const d = device(ME, [ACT], null, server);
    await syncOnce(d.deps, { first: true });
    const body = JSON.stringify(server.puts()[0].body);
    expect(body).not.toContain(ME);
    expect(Object.keys(server.puts()[0].body as object)).toEqual([
      "activities",
    ]);
  });
});

// --- the pure rules --------------------------------------------------------------

describe("reconcile and projectLocal", () => {
  const known = (id: string) => getActivityById(id) !== undefined;

  it("a tie leaves the server's item", () => {
    const remote = [
      activity({ activityId: ACT, updatedAt: NOW, tombstone: true }),
    ];
    const r = reconcile({
      local: [ACT],
      state: null,
      ownerId: ME,
      remote,
      nowIso: NOW,
      isKnown: known,
      first: true,
    });
    expect(r.merged[0].tombstone).toBe(true);
    expect(r.push).toHaveLength(0);
  });

  it("orders the device's list first, then what arrived by when it was added", () => {
    const out = projectLocal({
      local: [ACT3, ACT],
      items: [
        activity({ activityId: ACT, createdAt: T1 }),
        activity({ activityId: ACT3, createdAt: T2 }),
        activity({ activityId: ACT2, createdAt: T1 }),
      ],
      overflow: new Set(),
      foreign: false,
      isKnown: known,
    });
    expect(out).toEqual([ACT3, ACT, ACT2]);
  });
});

// --- when to run -----------------------------------------------------------------

function fakeScheduler() {
  let n = 0;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const scheduler: Scheduler = {
    setTimeout: (fn, ms) => {
      n += 1;
      timers.set(n, { fn, ms });
      return n;
    },
    clearTimeout: (h) => {
      timers.delete(h as number);
    },
  };
  return {
    scheduler,
    pending: () => [...timers.values()].map((t) => t.ms),
    /** Fire the one pending timer and let the run settle. */
    fire: async () => {
      const [id, t] = [...timers.entries()][0];
      timers.delete(id);
      t.fn();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

describe("backoff", () => {
  it("doubles from 30 s to a 15 minute ceiling", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(backoffMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000,
    ]);
    expect(backoffMs(50)).toBe(SYNC_BACKOFF_MAX_MS);
  });
});

describe("the controller", () => {
  const make = (outcomes: (SyncOutcome | "throw")[]) => {
    const sched = fakeScheduler();
    const run = vi.fn(async () => {
      const next = outcomes.shift() ?? { kind: "synced" as const };
      if (next === "throw") throw new Error("boom");
      return next;
    });
    return { sched, run, c: createPersonSyncController(run, sched.scheduler) };
  };

  it("starts after the delay it is given, once", async () => {
    const { sched, run, c } = make([]);
    c.start(3_000);
    expect(sched.pending()).toEqual([3_000]);
    await sched.fire();
    expect(run).toHaveBeenCalledTimes(1);
    expect(sched.pending()).toEqual([]);
  });

  it("folds a burst of changes into one run after the debounce", async () => {
    const { sched, run, c } = make([]);
    c.localChanged();
    c.localChanged();
    c.localChanged();
    expect(sched.pending()).toEqual([SYNC_DEBOUNCE_MS]);
    await sched.fire();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("backs off 30 s, 60 s, 120 s on failure and starts over after a success", async () => {
    const retry: SyncOutcome = { kind: "retry" };
    const { sched, run, c } = make([
      retry,
      retry,
      retry,
      { kind: "synced" },
      retry,
    ]);
    c.start(0);
    const seen: number[][] = [];
    for (let i = 0; i < 3; i++) {
      await sched.fire();
      seen.push(sched.pending());
    }
    expect(seen).toEqual([[30_000], [60_000], [120_000]]);
    await sched.fire(); // success
    expect(sched.pending()).toEqual([]);
    c.localChanged();
    await sched.fire(); // fails again, from the start of the schedule
    expect(sched.pending()).toEqual([30_000]);
    expect(run).toHaveBeenCalledTimes(5);
  });

  it("waits for Retry-After when it is longer than the backoff", async () => {
    const { sched, c } = make([{ kind: "retry", afterMs: 120_000 }]);
    c.start(0);
    await sched.fire();
    expect(sched.pending()).toEqual([120_000]);
  });

  it("does not hurry a pending retry because the person edits (no request storm)", async () => {
    const { sched, run, c } = make([{ kind: "retry" }]);
    c.start(0);
    await sched.fire();
    c.localChanged();
    c.localChanged();
    expect(sched.pending()).toEqual([30_000]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("tries once more soon after coming online, only if it was failing", async () => {
    const { sched, c } = make([{ kind: "retry" }]);
    c.online();
    expect(sched.pending()).toEqual([]);
    c.start(0);
    await sched.fire();
    c.online();
    expect(sched.pending()).toEqual([1_000]);
    c.online();
    expect(sched.pending()).toEqual([1_000]);
  });

  it("stops for good on a refusal that will not change", async () => {
    const { sched, run, c } = make([{ kind: "stopped", reason: "401" }]);
    c.start(0);
    await sched.fire();
    c.localChanged();
    c.online();
    c.start(0);
    expect(sched.pending()).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("treats a run that throws as a failure to retry, not a crash", async () => {
    const { sched, c } = make(["throw"]);
    c.start(0);
    await sched.fire();
    expect(sched.pending()).toEqual([30_000]);
  });

  it("never runs two passes at once; a change during one is folded into one more", async () => {
    const sched = fakeScheduler();
    let release: () => void = () => undefined;
    let active = 0;
    let maxActive = 0;
    const run = vi.fn(async (): Promise<SyncOutcome> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((r) => {
        release = r;
      });
      active -= 1;
      return { kind: "synced" };
    });
    const c = createPersonSyncController(run, sched.scheduler);
    c.start(0);
    const first = sched.fire();
    c.localChanged();
    c.localChanged();
    release();
    await first;
    expect(sched.pending()).toEqual([SYNC_DEBOUNCE_MS]);
    expect(maxActive).toBe(1);
  });

  it("stop() cancels what is pending", async () => {
    const { sched, run, c } = make([]);
    c.start(5_000);
    c.stop();
    expect(sched.pending()).toEqual([]);
    c.localChanged();
    expect(sched.pending()).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});
