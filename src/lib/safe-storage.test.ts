import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  readStorage,
  writeStorage,
  removeStorage,
  listStorageKeys,
  readStorageJSON,
  writeStorageJSON,
  parseStoredJSON,
} from "./safe-storage";

/** In-memory Storage double. */
function createStorage() {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((k: string) => (k in store ? store[k] : null)),
    setItem: vi.fn((k: string, v: string) => {
      store[k] = String(v);
    }),
    removeItem: vi.fn((k: string) => {
      delete store[k];
    }),
    clear: () => {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
}

function defineGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    configurable: true,
  });
}

function removeGlobal(name: string) {
  delete (globalThis as Record<string, unknown>)[name];
}

describe("safe-storage", () => {
  let local: ReturnType<typeof createStorage>;
  let session: ReturnType<typeof createStorage>;

  beforeEach(() => {
    local = createStorage();
    session = createStorage();
    // Simulate a browser: typeof window !== "undefined"
    defineGlobal("window", globalThis);
    defineGlobal("localStorage", local);
    defineGlobal("sessionStorage", session);
  });

  afterEach(() => {
    removeGlobal("window");
    removeGlobal("localStorage");
    removeGlobal("sessionStorage");
  });

  describe("round trip", () => {
    it("writes and reads a raw string from localStorage by default", () => {
      expect(writeStorage("k", "v")).toBe(true);
      expect(readStorage("k")).toBe("v");
      expect(local.setItem).toHaveBeenCalledWith("k", "v");
    });

    it("returns null for an absent key", () => {
      expect(readStorage("missing")).toBeNull();
    });

    it("removes a key", () => {
      writeStorage("k", "v");
      removeStorage("k");
      expect(readStorage("k")).toBeNull();
    });

    it("round-trips JSON values", () => {
      expect(writeStorageJSON("obj", { a: 1, b: [true] })).toBe(true);
      expect(readStorageJSON("obj", null)).toEqual({ a: 1, b: [true] });
    });
  });

  describe("storage kind", () => {
    it("routes to sessionStorage when asked", () => {
      writeStorage("k", "s", "session");
      expect(session.setItem).toHaveBeenCalledWith("k", "s");
      expect(local.setItem).not.toHaveBeenCalled();
      expect(readStorage("k", "session")).toBe("s");
      expect(readStorage("k")).toBeNull();
    });

    it("removes from sessionStorage when asked", () => {
      writeStorage("k", "s", "session");
      removeStorage("k", "session");
      expect(readStorage("k", "session")).toBeNull();
    });

    it("lists keys from the requested storage", () => {
      writeStorage("a", "1");
      writeStorage("b", "2", "session");
      expect(listStorageKeys()).toEqual(["a"]);
      expect(listStorageKeys("session")).toEqual(["b"]);
    });
  });

  describe("missing window (SSR)", () => {
    beforeEach(() => {
      removeGlobal("window");
    });

    it("read returns null and never touches storage", () => {
      expect(readStorage("k")).toBeNull();
      expect(local.getItem).not.toHaveBeenCalled();
    });

    it("write returns false without throwing", () => {
      expect(writeStorage("k", "v")).toBe(false);
      expect(local.setItem).not.toHaveBeenCalled();
    });

    it("remove is a no-op", () => {
      expect(() => removeStorage("k")).not.toThrow();
      expect(local.removeItem).not.toHaveBeenCalled();
    });

    it("JSON read returns the fallback and JSON write returns false", () => {
      expect(readStorageJSON("k", { fallback: true })).toEqual({
        fallback: true,
      });
      expect(writeStorageJSON("k", { a: 1 })).toBe(false);
    });

    it("listKeys returns an empty list", () => {
      expect(listStorageKeys()).toEqual([]);
    });
  });

  describe("throwing storage", () => {
    it("treats a throwing getter (blocked storage) as unavailable", () => {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        get() {
          throw new DOMException("blocked", "SecurityError");
        },
      });
      expect(readStorage("k")).toBeNull();
      expect(writeStorage("k", "v")).toBe(false);
      expect(() => removeStorage("k")).not.toThrow();
      expect(listStorageKeys()).toEqual([]);
    });

    it("returns null when getItem throws", () => {
      local.getItem.mockImplementation(() => {
        throw new Error("private mode");
      });
      expect(readStorage("k")).toBeNull();
      expect(readStorageJSON("k", "fallback")).toBe("fallback");
    });

    it("returns false when setItem throws (quota exceeded)", () => {
      local.setItem.mockImplementation(() => {
        throw new DOMException("full", "QuotaExceededError");
      });
      expect(writeStorage("k", "v")).toBe(false);
      expect(writeStorageJSON("k", { a: 1 })).toBe(false);
    });

    it("does not throw when removeItem throws", () => {
      local.removeItem.mockImplementation(() => {
        throw new Error("blocked");
      });
      expect(() => removeStorage("k")).not.toThrow();
    });

    it("returns an empty list when iteration throws", () => {
      defineGlobal("localStorage", {
        get length() {
          return 2;
        },
        key() {
          throw new Error("blocked");
        },
      });
      expect(listStorageKeys()).toEqual([]);
    });

    it("returns false when the value cannot be serialised", () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(writeStorageJSON("k", circular)).toBe(false);
      expect(local.setItem).not.toHaveBeenCalled();
    });
  });

  describe("bad JSON", () => {
    it("returns the fallback for malformed JSON", () => {
      writeStorage("k", "{not json");
      expect(readStorageJSON("k", { ok: false })).toEqual({ ok: false });
    });

    it("returns the fallback for an empty string", () => {
      writeStorage("k", "");
      expect(readStorageJSON("k", 7)).toBe(7);
    });

    it("returns the fallback for an absent key", () => {
      expect(readStorageJSON("nope", "fb")).toBe("fb");
    });

    it("parses a stored JSON null as null, not the fallback", () => {
      writeStorage("k", "null");
      expect(readStorageJSON<string | null>("k", "fb")).toBeNull();
    });

    it("parseStoredJSON handles null input and malformed input", () => {
      expect(parseStoredJSON(null, 1)).toBe(1);
      expect(parseStoredJSON("[", 1)).toBe(1);
      expect(parseStoredJSON("2", 1)).toBe(2);
    });
  });
});
