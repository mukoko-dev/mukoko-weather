/**
 * ThemeProvider, rendered: it must not undo the theme the script in the
 * document head settled from this device's own record (src/lib/theme.ts)
 * while the store still holds its default. A person who chose dark on a phone
 * set to light saw the page paint pale and flip dark about a second later, when
 * the preferences finished loading from IndexedDB.
 */
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  FakeDocument,
  FakeNode,
  mount,
  type Mounted,
} from "@/lib/test-render";
import { ThemeProvider } from "@/components/brand/ThemeProvider";
import { initRxDBBridge } from "@/lib/rxdb/bridge";
import { useAppStore } from "@/lib/store";
import { THEME_STORAGE_KEY } from "@/lib/theme";

vi.mock("@/lib/rxdb/bridge", () => ({
  updatePreferences: vi.fn(),
  initRxDBBridge: vi.fn(),
  getDeviceId: () => "test-device-id",
  migrateLocalStorageToRxDB: vi.fn().mockResolvedValue(undefined),
  _resetBridge: vi.fn(),
}));
vi.mock("@/lib/rxdb/replication", () => ({
  startReplication: vi.fn().mockResolvedValue(undefined),
  stopReplication: vi.fn().mockResolvedValue(undefined),
}));

/** The <html> element the provider writes `data-theme` on, and every theme it wrote. */
const root = new FakeNode(null as never);
const written: string[] = [];
const setAttribute = root.setAttribute.bind(root);
root.setAttribute = (name: string, value: string) => {
  if (name === "data-theme") written.push(value);
  setAttribute(name, value);
};

/** The page's `matchMedia("(prefers-color-scheme: dark)")`, and who listens. */
const system = { dark: false, listeners: [] as Array<() => void> };
const changeSystem = (dark: boolean) => {
  system.dark = dark;
  system.listeners.forEach((listener) => listener());
};

/** The device's localStorage. */
const data = new Map<string, string>();
const storage = {
  getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => void data.set(k, String(v)),
  removeItem: (k: string) => void data.delete(k),
};

let mounted: Mounted | undefined;

beforeEach(() => {
  data.clear();
  system.dark = false;
  system.listeners = [];
  root.attributes.clear();
  written.length = 0;
  useAppStore.setState({ theme: "system" });
  Object.defineProperty(FakeDocument.prototype, "documentElement", {
    get: () => root,
    configurable: true,
  });
  // `mount` makes the window itself, and the provider reads `matchMedia` while
  // it mounts: give every window it makes the system's answer.
  let current: Record<string, unknown> | undefined;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    get: () => current,
    set: (win: Record<string, unknown> | undefined) => {
      current = win;
      if (win) {
        win.matchMedia = () => ({
          get matches() {
            return system.dark;
          },
          addEventListener: (_: string, fn: () => void) =>
            void system.listeners.push(fn),
          removeEventListener: (_: string, fn: () => void) => {
            system.listeners = system.listeners.filter((l) => l !== fn);
          },
        });
      }
    },
  });
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  delete (globalThis as { window?: unknown }).window;
  delete (FakeDocument.prototype as { documentElement?: unknown })
    .documentElement;
});

/** Opens the page: the device has recorded `recorded` (or nothing), and the system is `system`. */
async function open(recorded?: "light" | "dark") {
  if (recorded) data.set(THEME_STORAGE_KEY, recorded);
  mounted = await mount(createElement(ThemeProvider, null, "page"), {
    localStorage: storage,
  });
}

describe("before the preferences have loaded from IndexedDB", () => {
  beforeEach(() => {
    // The database is still starting: the store has not been told anything.
    vi.mocked(initRxDBBridge).mockReturnValue(new Promise(() => {}));
  });

  it("keeps the theme the device recorded, though the store still holds its default (dark chosen on a light phone)", async () => {
    system.dark = false;
    await open("dark");
    expect(root.getAttribute("data-theme")).toBe("dark");
    // Not even for one pass: a pale frame between the two is the flash.
    expect(written).not.toContain("light");
  });

  it("keeps a recorded light theme on a dark phone", async () => {
    system.dark = true;
    await open("light");
    expect(root.getAttribute("data-theme")).toBe("light");
    expect(written).not.toContain("dark");
  });

  it("follows the system when the device recorded nothing", async () => {
    system.dark = true;
    await open();
    expect(root.getAttribute("data-theme")).toBe("dark");
    await mounted?.unmount();
    mounted = undefined;
    system.dark = false;
    await open();
    expect(root.getAttribute("data-theme")).toBe("light");
  });

  it("does not let a change of the system's setting override the recorded choice", async () => {
    system.dark = false;
    await open("dark");
    // It does not even listen: an explicit choice has nothing to follow.
    expect(system.listeners).toHaveLength(0);
    changeSystem(true);
    expect(root.getAttribute("data-theme")).toBe("dark");
    changeSystem(false);
    expect(root.getAttribute("data-theme")).toBe("dark");
  });

  it("follows a change of the system's setting when the device recorded nothing", async () => {
    system.dark = false;
    await open();
    changeSystem(true);
    expect(root.getAttribute("data-theme")).toBe("dark");
  });
});

describe("once the preferences have loaded", () => {
  beforeEach(() => {
    vi.mocked(initRxDBBridge).mockResolvedValue(undefined);
  });

  it("follows the theme the store holds", async () => {
    system.dark = false;
    await open();
    await act(async () => {
      useAppStore.getState().setTheme("dark");
    });
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(data.get(THEME_STORAGE_KEY)).toBe("dark");
    await act(async () => {
      useAppStore.getState().setTheme("system");
    });
    expect(root.getAttribute("data-theme")).toBe("light");
    expect(data.has(THEME_STORAGE_KEY)).toBe(false);
  });

  it("follows the system again when the preference is the system's, whatever the device recorded before", async () => {
    system.dark = true;
    await open("light");
    // The preferences say "system" (the person went back to it on another
    // device): the store applies it, and the stale record is dropped.
    await act(async () => {
      useAppStore.getState().setTheme("system");
    });
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(data.has(THEME_STORAGE_KEY)).toBe(false);
    changeSystem(false);
    expect(root.getAttribute("data-theme")).toBe("light");
  });
});
