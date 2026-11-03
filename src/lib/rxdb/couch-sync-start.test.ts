/**
 * The page's starter, with the flag ON and a stubbed browser: it tears the
 * engine down when the page goes away and starts it again when the page is
 * restored from the back/forward cache; a sign-out (the route answering 401)
 * wipes what an earlier sign-in left in IndexedDB without ever throwing, also
 * when IndexedDB is missing or blocked; and with the flag OFF it reads and
 * creates nothing: no storage, no IndexedDB, no listener, no request.
 *
 * (The import guards and the flag-off behaviour proper are
 * `couch-sync-flag-off.test.ts`; this file adds what the starter owns now.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetCouchSyncStart, startCouchSync } from "./couch-sync-start";
import type { CouchSyncEngine } from "./couch-sync";
import { SYNC_PEOPLE_KEY, recordedSyncPeople } from "./sync-people-index";
import { SYNC_PENDING_KEY } from "./sync-pending";
import { SYNC_SIGNED_OUT_KEY } from "./sync-signed-out";
import { SIGNED_OUT_CODE } from "../couch-session-contract";
import { FakeBridge } from "./test-support/couch-engine-harness";

const PERSON = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

// The real engine, with its `flush` observable.
const flushes: ReturnType<typeof vi.fn>[] = [];
vi.mock("./couch-sync", async (importOriginal) => {
  const real = await importOriginal<typeof import("./couch-sync")>();
  return {
    ...real,
    createCouchSyncEngine: (
      deps: Parameters<typeof real.createCouchSyncEngine>[0],
    ) => {
      const engine: CouchSyncEngine = real.createCouchSyncEngine(deps);
      const flush = vi.fn(engine.flush);
      engine.flush = flush as never;
      flushes.push(flush);
      return engine;
    },
  };
});

// The real RxDB layer, with the order of its opens against requests observable.
const order: string[] = [];
vi.mock("./couch-rxdb", async (importOriginal) => {
  const real = await importOriginal<typeof import("./couch-rxdb")>();
  return {
    ...real,
    openUserDocStore: (...args: Parameters<typeof real.openUserDocStore>) => {
      order.push("local database");
      return real.openUserDocStore(...args);
    },
  };
});

type Handler = (event?: unknown) => void;
let handlers: Map<string, Set<Handler>>;
let storage: Map<string, string>;
let storageCalls: string[];
let indexedDbCalls: string[];
let fetchSpy: ReturnType<typeof vi.fn>;

function stubBrowser(flag: "true" | "false" | null) {
  handlers = new Map();
  storage = new Map();
  storageCalls = [];
  indexedDbCalls = [];
  if (flag) storage.set("ff:couch_sync", flag);
  const add = (type: string, fn: Handler) => {
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type)?.add(fn);
  };
  const remove = (type: string, fn: Handler) => {
    handlers.get(type)?.delete(fn);
  };
  vi.stubGlobal("window", {
    addEventListener: add,
    removeEventListener: remove,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: number) => clearTimeout(h),
  });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => {
      // The flag read is the only storage access allowed with the flag off.
      if (k !== "ff:couch_sync") storageCalls.push(`get ${k}`);
      return storage.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      storageCalls.push(`set ${k}`);
      storage.set(k, v);
    },
    removeItem: (k: string) => {
      storageCalls.push(`remove ${k}`);
      storage.delete(k);
    },
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: add,
    removeEventListener: remove,
  });
  vi.stubGlobal("navigator", { onLine: true });
  // IndexedDB is absent in node; if anything reaches for it, record that.
  vi.stubGlobal("indexedDB", {
    open: () => {
      indexedDbCalls.push("open");
      throw new Error("IndexedDB is blocked");
    },
    deleteDatabase: () => {
      indexedDbCalls.push("deleteDatabase");
      throw new Error("IndexedDB is blocked");
    },
    databases: () => {
      indexedDbCalls.push("databases");
      throw new Error("IndexedDB is blocked");
    },
  });
}

const fire = (type: string, event?: unknown) =>
  [...(handlers.get(type) ?? [])].forEach((h) => h(event));
const listenerCount = () =>
  [...handlers.values()].reduce((n, set) => n + set.size, 0);

async function untilRequests(n: number) {
  for (let i = 0; i < 100 && fetchSpy.mock.calls.length < n; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function settle() {
  await new Promise((r) => setTimeout(r, 30));
}

beforeEach(() => {
  _resetCouchSyncStart();
  fetchSpy = vi.fn(
    async () =>
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
  );
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("flag off: nothing is read, created or requested", () => {
  it.each([null, "false" as const])("flag %s", async (flag) => {
    stubBrowser(flag);
    storage.set(SYNC_PEOPLE_KEY, JSON.stringify([PERSON]));
    const bridge = new FakeBridge();
    expect(await startCouchSync(bridge, "device")).toBeNull();
    await settle();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storageCalls).toEqual([]); // not even the record of people
    expect(indexedDbCalls).toEqual([]);
    expect(listenerCount()).toBe(0);
    expect(bridge.listenerCount).toBe(0);
    // What was there is left exactly as it was.
    expect(storage.get(SYNC_PEOPLE_KEY)).toBe(JSON.stringify([PERSON]));
  });
});

describe("flag on: the page going away and coming back", () => {
  it("pagehide stops the engine; a page restored from the back/forward cache starts it again", async () => {
    stubBrowser("true");
    const bridge = new FakeBridge();
    const handle = await startCouchSync(bridge, "device");
    expect(handle).not.toBeNull();
    await untilRequests(1);
    await settle();
    expect(handlers.get("pagehide")?.size).toBe(1);
    expect(handlers.get("pageshow")?.size).toBe(1);

    // Signed out (401): the engine is idle but still subscribed to the app.
    fire("pagehide", { persisted: false });
    await settle();
    expect(bridge.listenerCount).toBe(0);

    // An ordinary pageshow (not from the cache) does nothing.
    fire("pageshow", { persisted: false });
    await settle();
    expect(bridge.listenerCount).toBe(0);

    // Restored from the back/forward cache: it starts again, and asks again.
    fire("pageshow", { persisted: true });
    await untilRequests(2);
    await settle();
    expect(bridge.listenerCount).toBe(1);
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual([
      "/api/couch/session",
      "/api/couch/session",
    ]);
    await handle?.stop();
  });

  it("the handle's stop() removes every listener the starter added", async () => {
    stubBrowser("true");
    const bridge = new FakeBridge();
    const handle = await startCouchSync(bridge, "device");
    await untilRequests(1);
    await settle();
    expect(listenerCount()).toBeGreaterThan(0);
    await handle?.stop();
    expect(listenerCount()).toBe(0);
    expect(bridge.listenerCount).toBe(0);
  });
});

describe("flag on: signed out", () => {
  it("makes one request, and removes nothing when nothing was recorded (IndexedDB is not touched)", async () => {
    stubBrowser("true");
    const handle = await startCouchSync(new FakeBridge(), "device");
    await untilRequests(1);
    await settle();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(indexedDbCalls).toEqual([]);
    await handle?.stop();
  });

  /** The route says what it says when nobody is signed in. */
  const routeSaysSignedOut = () =>
    fetchSpy.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: SIGNED_OUT_CODE }), {
          status: 401,
        }),
    );

  it("the first 401 only leaves a mark (one time, nothing else) and removes nothing, even for a person who is recorded", async () => {
    stubBrowser("true");
    routeSaysSignedOut();
    // (Another person than the next test's: RxDB refuses a second database of
    // one name in a process, and a blocked IndexedDB leaves the first one
    // registered.)
    const recorded = "0190ffff-0000-7000-8000-00000000abcd";
    storage.set(SYNC_PEOPLE_KEY, JSON.stringify([recorded]));
    const before = Date.now();
    const handle = await startCouchSync(new FakeBridge(), "device");
    await untilRequests(1);
    await settle();
    const mark = storage.get(SYNC_SIGNED_OUT_KEY);
    expect(mark).toMatch(/^\d+$/);
    expect(Number(mark)).toBeGreaterThanOrEqual(before);
    expect(recordedSyncPeople()).toEqual([recorded]);
    // The recorded person's database was not touched by a removal.
    expect(indexedDbCalls).not.toContain("deleteDatabase");
    await handle?.stop();
  });

  it("a person recorded by an earlier sign-in whose database cannot be removed (IndexedDB blocked or missing), the second time nobody is signed in, never throws and stays recorded", async () => {
    stubBrowser("true");
    routeSaysSignedOut();
    storage.set(SYNC_PEOPLE_KEY, JSON.stringify([PERSON]));
    // The first answer was heard two minutes ago.
    storage.set(SYNC_SIGNED_OUT_KEY, String(Date.now() - 120_000));
    const handle = await startCouchSync(new FakeBridge(), "device");
    await untilRequests(1);
    // Removing loads RxDB's Dexie storage first: give it a moment.
    for (let i = 0; i < 200 && indexedDbCalls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(handle).not.toBeNull();
    // It did try (and IndexedDB refused); no exception reached anyone, and
    // the person stays recorded so the next run tries again.
    expect(indexedDbCalls.length).toBeGreaterThan(0);
    expect(recordedSyncPeople()).toEqual([PERSON]);
    await handle?.stop();
  });
});

describe("flag on: offline first", () => {
  beforeEach(() => {
    flushes.length = 0;
    order.length = 0;
  });

  /** The route is down for a while (not signed out), and every ask is logged. */
  function routeDown(): void {
    fetchSpy.mockImplementation(async () => {
      order.push("credential");
      return new Response(JSON.stringify({ error: "couch_unavailable" }), {
        status: 503,
      });
    });
  }

  it("a browser that holds one person's database opens it before it asks the route for anything", async () => {
    stubBrowser("true");
    storage.set(SYNC_PEOPLE_KEY, JSON.stringify([PERSON]));
    routeDown();
    const handle = await startCouchSync(new FakeBridge(), "device");
    await untilRequests(1);
    await settle();
    expect(order[0]).toBe("local database");
    expect(order).toContain("credential");
    await handle?.stop();
  });

  it("with several people recorded the starter guesses none", async () => {
    stubBrowser("true");
    storage.set(
      SYNC_PEOPLE_KEY,
      JSON.stringify([PERSON, "0190ffff-0000-7000-8000-00000000abcd"]),
    );
    routeDown();
    const handle = await startCouchSync(new FakeBridge(), "device");
    await untilRequests(1);
    await settle();
    expect(order[0]).toBe("credential");
    await handle?.stop();
  });

  it("a change the person makes is recorded in web storage at once, and only the settings", async () => {
    stubBrowser("true");
    routeDown(); // signed in, the credential just is not available yet
    const bridge = new FakeBridge();
    const handle = await startCouchSync(bridge, "device");
    await untilRequests(1);
    await settle();
    expect(storage.has(SYNC_PENDING_KEY)).toBe(false);
    bridge.change({ theme: "dark" });
    const raw = storage.get(SYNC_PENDING_KEY);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw as string)).toMatchObject({
      base: { theme: "system" },
    });
    await handle?.stop();
  });

  it("the page being hidden writes the pending change now; being shown does not", async () => {
    stubBrowser("true");
    const handle = await startCouchSync(new FakeBridge(), "device");
    await untilRequests(1);
    await settle();
    const [flush] = flushes;
    const doc = (globalThis as { document: { visibilityState: string } })
      .document;
    doc.visibilityState = "visible";
    fire("visibilitychange");
    expect(flush).not.toHaveBeenCalled();
    doc.visibilityState = "hidden";
    fire("visibilitychange");
    expect(flush).toHaveBeenCalledTimes(1);
    await handle?.stop();
    expect(listenerCount()).toBe(0);
  });
});
