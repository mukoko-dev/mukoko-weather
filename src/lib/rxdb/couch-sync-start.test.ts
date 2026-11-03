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
import { SYNC_PEOPLE_KEY, recordedSyncPeople } from "./sync-people-index";
import { FakeBridge } from "./test-support/couch-engine-harness";

const PERSON = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

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

  it("a person recorded by an earlier sign-in whose database cannot be removed (IndexedDB blocked or missing) never throws and stays recorded", async () => {
    stubBrowser("true");
    storage.set(SYNC_PEOPLE_KEY, JSON.stringify([PERSON]));
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
