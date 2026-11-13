/**
 * Tests for theme.ts — the dependency-free theme resolver shared by the
 * embed widget, the map, and the store (re-exported from store.ts).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  readStoredTheme,
  rememberTheme,
  resolveTheme,
  THEME_INIT_SCRIPT,
  THEME_STORAGE_KEY,
} from "./theme";
import * as storeModule from "./store";

describe("resolveTheme", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes explicit light/dark preferences through", () => {
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("follows the OS preference for system", () => {
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: true }),
    });
    expect(resolveTheme("system")).toBe("dark");
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false }),
    });
    expect(resolveTheme("system")).toBe("light");
  });

  it("resolves system to light without a window (SSR)", () => {
    vi.stubGlobal("window", undefined);
    expect(resolveTheme("system")).toBe("light");
  });

  it("is the same function store.ts re-exports", () => {
    expect(storeModule.resolveTheme).toBe(resolveTheme);
  });
});

/** An in-memory localStorage, for the whole of globalThis (what safe-storage reads). */
function stubStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
  });
  return data;
}

describe("the device's record of the theme", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records an explicit choice and forgets it for system", () => {
    const data = stubStorage();
    rememberTheme("dark");
    expect(data.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(readStoredTheme()).toBe("dark");
    rememberTheme("light");
    expect(readStoredTheme()).toBe("light");
    rememberTheme("system");
    expect(data.has(THEME_STORAGE_KEY)).toBe(false);
    expect(readStoredTheme()).toBeNull();
  });

  it("reads only light or dark, nothing else a script or an old build left", () => {
    const data = stubStorage({ [THEME_STORAGE_KEY]: "system" });
    expect(readStoredTheme()).toBeNull();
    data.set(THEME_STORAGE_KEY, "<script>");
    expect(readStoredTheme()).toBeNull();
    data.set(THEME_STORAGE_KEY, "");
    expect(readStoredTheme()).toBeNull();
  });

  it("never throws where storage is blocked or there is no window", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", {
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
    expect(() => rememberTheme("dark")).not.toThrow();
    expect(() => rememberTheme("system")).not.toThrow();
    expect(readStoredTheme()).toBeNull();
    vi.stubGlobal("window", undefined);
    expect(readStoredTheme()).toBeNull();
  });
});

/**
 * Runs the script that the root layout puts in the document head, against a
 * stand-in for the page, and returns the theme it set (and how often).
 */
function settle(device: {
  stored?: string;
  legacy?: string;
  systemDark?: boolean;
  storageBlocked?: boolean;
  noMatchMedia?: boolean;
}) {
  const set: string[] = [];
  const doc = {
    documentElement: {
      setAttribute: (name: string, value: string) => {
        if (name === "data-theme") set.push(value);
      },
    },
  };
  const storage = {
    getItem: (key: string) => {
      if (device.storageBlocked) throw new Error("blocked");
      if (key === THEME_STORAGE_KEY) return device.stored ?? null;
      if (key === "mukoko-weather-prefs") return device.legacy ?? null;
      return null;
    },
  };
  const matchMedia = (query: string) => {
    if (device.noMatchMedia) throw new Error("no matchMedia");
    expect(query).toBe("(prefers-color-scheme:dark)");
    return { matches: device.systemDark === true };
  };
  new Function("document", "localStorage", "matchMedia", THEME_INIT_SCRIPT)(
    doc,
    storage,
    matchMedia,
  );
  return set;
}

describe("the theme is settled before first paint (THEME_INIT_SCRIPT)", () => {
  it("follows the system on a device with no recorded choice", () => {
    expect(settle({ systemDark: true })).toEqual(["dark"]);
    expect(settle({ systemDark: false })).toEqual(["light"]);
  });

  it("uses the choice this device recorded over the system's: dark chosen on a light phone", () => {
    expect(settle({ stored: "dark", systemDark: false })).toEqual(["dark"]);
    expect(settle({ stored: "light", systemDark: true })).toEqual(["light"]);
  });

  it("sets the theme once, so nothing flips under it", () => {
    expect(settle({ stored: "dark", systemDark: false })).toHaveLength(1);
    expect(settle({ systemDark: true })).toHaveLength(1);
  });

  it("ignores a recorded value that is not a theme", () => {
    expect(settle({ stored: "system", systemDark: true })).toEqual(["dark"]);
    expect(settle({ stored: "blue", systemDark: false })).toEqual(["light"]);
  });

  it("still reads the old preferences key, for a device whose IndexedDB never worked", () => {
    const legacy = JSON.stringify({ state: { theme: "dark" } });
    expect(settle({ legacy, systemDark: false })).toEqual(["dark"]);
    // The recorded choice is newer than the old key.
    expect(settle({ legacy, stored: "light", systemDark: true })).toEqual([
      "light",
    ]);
    // The old key can say "system" (or be broken): the system decides.
    const system = JSON.stringify({ state: { theme: "system" } });
    expect(settle({ legacy: system, systemDark: true })).toEqual(["dark"]);
    expect(settle({ legacy: "{not json", systemDark: false })).toEqual([
      "light",
    ]);
  });

  it("falls back to the system when storage is blocked, and to light when nothing can be read", () => {
    expect(settle({ storageBlocked: true, systemDark: true })).toEqual([
      "dark",
    ]);
    expect(settle({ storageBlocked: true, noMatchMedia: true })).toEqual([
      "light",
    ]);
  });

  it("is plain ES5 with no imports: the server sends it as a string", () => {
    expect(THEME_INIT_SCRIPT).not.toMatch(/=>|\blet\b|\bconst\b|`|\bimport\b/);
    expect(() => new Function(THEME_INIT_SCRIPT)).not.toThrow();
  });

  it("is what the root layout sends, and the only theme script it sends", () => {
    const layout = readFileSync(
      resolve(__dirname, "../app/layout.tsx"),
      "utf-8",
    );
    expect(layout).toContain(
      "<script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />",
    );
    expect(layout).toContain('import { THEME_INIT_SCRIPT } from "@/lib/theme"');
    expect(layout).not.toContain("mukoko-weather-prefs");
  });

  it("is the same rule in the Astro shell, on the same keys", () => {
    const shell = readFileSync(
      resolve(__dirname, "../../astro/src/layouts/Shell.astro"),
      "utf-8",
    );
    expect(shell).toContain(`localStorage.getItem("${THEME_STORAGE_KEY}")`);
    expect(shell).toContain('localStorage.getItem("mukoko-weather-prefs")');
    // The recorded choice is read before the old key and the system.
    expect(shell.indexOf(THEME_STORAGE_KEY)).toBeLessThan(
      shell.indexOf("mukoko-weather-prefs"),
    );
    expect(shell.indexOf("mukoko-weather-prefs")).toBeLessThan(
      shell.indexOf("prefers-color-scheme"),
    );
  });
});
