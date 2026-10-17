import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DEVICE_STATE_KEY,
  DISMISS_RETRY_MS,
  clearDeviceState,
  decideLocationAsk,
  readBrowserPermission,
  readDeviceState,
  recordPermission,
  type StoredPermission,
} from "./device-state";

function createStorage() {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      store = {};
    },
    raw: () => store,
  };
}

function defineGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    configurable: true,
  });
}

let storage: ReturnType<typeof createStorage>;

beforeEach(() => {
  storage = createStorage();
  defineGlobal("window", globalThis);
  defineGlobal("localStorage", storage);
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "localStorage");
  Reflect.deleteProperty(globalThis, "navigator");
});

const stored = (
  state: StoredPermission["state"],
  changedAt = 1000,
): StoredPermission => ({ state, changedAt });

describe("device state mirror", () => {
  it("starts with nothing decided", () => {
    expect(readDeviceState()).toEqual({
      v: 1,
      geolocation: null,
      notifications: null,
    });
  });

  it("records an outcome and reads it back", () => {
    recordPermission("geolocation", "granted", 5);
    expect(readDeviceState().geolocation).toEqual({
      state: "granted",
      changedAt: 5,
    });
    expect(readDeviceState().notifications).toBeNull();
  });

  it("moves changedAt only when the state changes", () => {
    recordPermission("geolocation", "denied", 10);
    recordPermission("geolocation", "denied", 99);
    expect(readDeviceState().geolocation?.changedAt).toBe(10);
    recordPermission("geolocation", "granted", 200);
    expect(readDeviceState().geolocation).toEqual({
      state: "granted",
      changedAt: 200,
    });
  });

  it("treats anything malformed as nothing decided", () => {
    storage.setItem(DEVICE_STATE_KEY, "{not json");
    expect(readDeviceState().geolocation).toBeNull();
    storage.setItem(
      DEVICE_STATE_KEY,
      JSON.stringify({ v: 1, geolocation: { state: "maybe", changedAt: 1 } }),
    );
    expect(readDeviceState().geolocation).toBeNull();
    storage.setItem(DEVICE_STATE_KEY, JSON.stringify({ v: 2 }));
    expect(readDeviceState().geolocation).toBeNull();
  });

  it("stores no position, address or user agent", () => {
    recordPermission("geolocation", "granted", 1);
    recordPermission("notifications", "denied", 2);
    expect(
      Object.keys(JSON.parse(storage.raw()[DEVICE_STATE_KEY])).sort(),
    ).toEqual(["geolocation", "notifications", "v"]);
  });

  it("clears", () => {
    recordPermission("geolocation", "granted", 1);
    clearDeviceState();
    expect(readDeviceState().geolocation).toBeNull();
  });

  it("does not throw when storage is blocked", () => {
    defineGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => recordPermission("geolocation", "granted")).not.toThrow();
    expect(readDeviceState().geolocation).toBeNull();
  });
});

describe("decideLocationAsk — first load, granted, denied, signed-out PWA", () => {
  it("first load, nothing stored, browser would prompt: show the pre-prompt", () => {
    expect(decideLocationAsk({ browser: "prompt", stored: null })).toBe(
      "show-prompt",
    );
  });

  it("a fresh installed PWA (browser cannot say, nothing stored): pre-prompt, never an automatic call", () => {
    expect(decideLocationAsk({ browser: "unknown", stored: null })).toBe(
      "show-prompt",
    );
  });

  it("granted: refresh silently, whatever was stored", () => {
    expect(decideLocationAsk({ browser: "granted", stored: null })).toBe(
      "refresh-silently",
    );
    expect(
      decideLocationAsk({ browser: "granted", stored: stored("denied") }),
    ).toBe("refresh-silently");
  });

  it("denied: never ask again", () => {
    expect(decideLocationAsk({ browser: "denied", stored: null })).toBe(
      "hide-denied",
    );
  });

  it("browser cannot say but we stored a block: still never ask", () => {
    expect(
      decideLocationAsk({ browser: "unknown", stored: stored("denied") }),
    ).toBe("hide-denied");
  });

  it("browser cannot say but we stored granted: show the card (a tap is needed), do not call the API", () => {
    expect(
      decideLocationAsk({ browser: "unknown", stored: stored("granted") }),
    ).toBe("show-prompt");
  });

  it("the person reset the block in browser settings: ask again", () => {
    expect(
      decideLocationAsk({ browser: "prompt", stored: stored("denied") }),
    ).toBe("show-prompt");
  });

  it("'Not now' holds for a week, then may ask once more", () => {
    const at = 1_000_000;
    expect(
      decideLocationAsk({
        browser: "prompt",
        stored: stored("dismissed", at),
        now: at + DISMISS_RETRY_MS - 1,
      }),
    ).toBe("hide-dismissed");
    expect(
      decideLocationAsk({
        browser: "prompt",
        stored: stored("dismissed", at),
        now: at + DISMISS_RETRY_MS,
      }),
    ).toBe("show-prompt");
  });
});

describe("readBrowserPermission", () => {
  it("returns the browser's state", async () => {
    defineGlobal("navigator", {
      permissions: { query: vi.fn(async () => ({ state: "granted" })) },
    });
    expect(await readBrowserPermission("geolocation")).toBe("granted");
  });
  it("is unknown when the Permissions API is missing or throws", async () => {
    defineGlobal("navigator", {});
    expect(await readBrowserPermission()).toBe("unknown");
    defineGlobal("navigator", {
      permissions: {
        query: async () => {
          throw new TypeError("unsupported");
        },
      },
    });
    expect(await readBrowserPermission()).toBe("unknown");
  });
});
