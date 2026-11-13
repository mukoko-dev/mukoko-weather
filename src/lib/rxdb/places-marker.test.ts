import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PLACES_MARKER_KEY,
  PROBE_TIMEOUT_MS,
  _resetPlacesMarker,
  markNoPlacesStored,
  markPlacesStored,
  placesMayExist,
} from "./places-marker";

// The marker that lets a first visit skip opening the on-device database
// (issue 551). The one rule: only a positive "nothing is stored here" skips
// it; whatever cannot be established goes on as before.

/** An in-memory localStorage; `blocked` makes every access throw, as a browser setting can. */
function stubStorage(blocked = false) {
  const data = new Map<string, string>();
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => {
      if (blocked) throw new Error("blocked");
      return data.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (blocked) throw new Error("blocked");
      data.set(k, String(v));
    },
    removeItem: (k: string) => void data.delete(k),
  });
  return data;
}

function stubIndexedDb(
  databases: (() => Promise<Array<{ name?: string }>>) | undefined,
) {
  vi.stubGlobal("indexedDB", databases ? { databases } : {});
}

const dexieNames = [
  { name: "rxdb-dexie-mukoko_weather--0--_rxdb_internal" },
  { name: "rxdb-dexie-mukoko_weather--4--preferences" },
];

beforeEach(() => {
  _resetPlacesMarker();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a device that is known to hold nothing", () => {
  it("marker 0 answers no, at once, without listing any database", async () => {
    const data = stubStorage();
    data.set(PLACES_MARKER_KEY, "0");
    const databases = vi.fn(async () => dexieNames);
    stubIndexedDb(databases);
    expect(await placesMayExist()).toBe(false);
    expect(databases).not.toHaveBeenCalled();
  });

  it("a first visit (no marker, no database) answers no and records it", async () => {
    const data = stubStorage();
    const databases = vi.fn(async () => []);
    stubIndexedDb(databases);
    expect(await placesMayExist()).toBe(false);
    expect(data.get(PLACES_MARKER_KEY)).toBe("0");
    // asked once for the page, then the marker answers
    expect(await placesMayExist()).toBe(false);
    expect(databases).toHaveBeenCalledTimes(1);
  });

  it("another database on the origin is not this one", async () => {
    const data = stubStorage();
    stubIndexedDb(async () => [{ name: "workbox-expiration" }, { name: "x" }]);
    expect(await placesMayExist()).toBe(false);
    expect(data.get(PLACES_MARKER_KEY)).toBe("0");
  });
});

describe("a device that may hold something behaves as before", () => {
  it("marker 1 answers yes without listing any database", async () => {
    const data = stubStorage();
    data.set(PLACES_MARKER_KEY, "1");
    const databases = vi.fn(async () => []);
    stubIndexedDb(databases);
    expect(await placesMayExist()).toBe(true);
    expect(databases).not.toHaveBeenCalled();
  });

  it("a device from before the marker (no marker, a database) answers yes and records it", async () => {
    const data = stubStorage();
    stubIndexedDb(async () => dexieNames);
    expect(await placesMayExist()).toBe(true);
    expect(data.get(PLACES_MARKER_KEY)).toBe("1");
  });

  it("a browser that cannot list databases answers yes, and records nothing", async () => {
    const data = stubStorage();
    stubIndexedDb(undefined);
    expect(await placesMayExist()).toBe(true);
    expect(data.has(PLACES_MARKER_KEY)).toBe(false);
  });

  it("no IndexedDB at all answers yes", async () => {
    stubStorage();
    vi.stubGlobal("indexedDB", undefined);
    expect(await placesMayExist()).toBe(true);
  });

  it("a listing that fails answers yes", async () => {
    const data = stubStorage();
    stubIndexedDb(async () => {
      throw new Error("SecurityError");
    });
    expect(await placesMayExist()).toBe(true);
    expect(data.has(PLACES_MARKER_KEY)).toBe(false);
  });

  it("a listing that does not answer in time answers yes", async () => {
    vi.useFakeTimers();
    const data = stubStorage();
    stubIndexedDb(() => new Promise(() => {}));
    const answer = placesMayExist();
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1);
    expect(await answer).toBe(true);
    expect(data.has(PLACES_MARKER_KEY)).toBe(false);
  });

  it("the server answers yes (there is no database there to skip)", async () => {
    vi.unstubAllGlobals();
    expect(typeof window).toBe("undefined");
    expect(await placesMayExist()).toBe(true);
  });

  it("a marker with any other value is not trusted", async () => {
    const data = stubStorage();
    data.set(PLACES_MARKER_KEY, "maybe");
    stubIndexedDb(async () => dexieNames);
    expect(await placesMayExist()).toBe(true);
    expect(data.get(PLACES_MARKER_KEY)).toBe("1");
  });
});

describe("storing and clearing", () => {
  it("storing a place turns a device that held nothing into one that may", async () => {
    const data = stubStorage();
    stubIndexedDb(async () => []);
    expect(await placesMayExist()).toBe(false);
    markPlacesStored();
    expect(data.get(PLACES_MARKER_KEY)).toBe("1");
    expect(await placesMayExist()).toBe(true);
  });

  it("clearing every place turns a device that held some into one that holds none", async () => {
    const data = stubStorage();
    data.set(PLACES_MARKER_KEY, "1");
    markNoPlacesStored();
    expect(data.get(PLACES_MARKER_KEY)).toBe("0");
    expect(await placesMayExist()).toBe(false);
  });

  it("clearing the browser's storage brings back the check by name, not a wrong answer", async () => {
    const data = stubStorage();
    data.set(PLACES_MARKER_KEY, "0");
    expect(await placesMayExist()).toBe(false);
    // localStorage wiped on its own while IndexedDB still holds the database
    data.clear();
    _resetPlacesMarker();
    stubIndexedDb(async () => dexieNames);
    expect(await placesMayExist()).toBe(true);
    expect(data.get(PLACES_MARKER_KEY)).toBe("1");
  });
});

describe("with localStorage full", () => {
  it("a write that is refused takes the old 0 away, so the next visit looks by name", async () => {
    const data = stubStorage();
    data.set(PLACES_MARKER_KEY, "0");
    // a full store: setItem throws, removeItem still works
    const real = (globalThis as unknown as { localStorage: Storage })
      .localStorage;
    vi.stubGlobal("localStorage", {
      getItem: real.getItem.bind(real),
      removeItem: real.removeItem.bind(real),
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    markPlacesStored();
    expect(data.has(PLACES_MARKER_KEY)).toBe(false);
    // a new page load: no marker, so the database is looked for and found
    _resetPlacesMarker();
    stubIndexedDb(async () => dexieNames);
    expect(await placesMayExist()).toBe(true);
  });
});

describe("with localStorage blocked", () => {
  it("lists the databases once per page and stays right when a place is stored", async () => {
    stubStorage(true);
    const databases = vi.fn(async () => []);
    stubIndexedDb(databases);
    expect(await placesMayExist()).toBe(false);
    expect(await placesMayExist()).toBe(false);
    expect(databases).toHaveBeenCalledTimes(1);
    // the marker cannot be kept, but this page must not forget it just stored one
    markPlacesStored();
    expect(await placesMayExist()).toBe(true);
  });

  it("a device with a database still answers yes", async () => {
    stubStorage(true);
    stubIndexedDb(async () => dexieNames);
    expect(await placesMayExist()).toBe(true);
  });
});
