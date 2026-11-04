/**
 * The gate: the sync code is loaded and started only for a signed-in person
 * while the platform is ready, it is stopped when the person goes, and until
 * then it is not even fetched. React and the sync itself are stand-ins.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const flags = vi.hoisted(() => ({ ready: true }));
vi.mock("./person-preferences-switches", () => ({
  get PERSON_PREFERENCES_READY() {
    return flags.ready;
  },
  PERSON_SAVED_PLACES_READY: false,
}));

let cleanup: (() => void) | void;
vi.mock("react", () => ({
  useEffect: (fn: () => (() => void) | void) => {
    cleanup = fn();
  },
}));

const stopMock = vi.hoisted(() => vi.fn());
const startMock = vi.hoisted(() => vi.fn());
// The factory runs only when the module is actually imported.
const moduleLoaded = vi.hoisted(() => vi.fn());
vi.mock("./person-preferences-sync-start", () => {
  moduleLoaded();
  return { startPersonPreferencesSync: startMock };
});

import { usePersonPreferencesSync } from "./use-person-preferences-sync";

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  flags.ready = true;
  cleanup = undefined;
  stopMock.mockReset();
  startMock.mockReset();
  startMock.mockReturnValue(stopMock);
  moduleLoaded.mockReset();
});

describe("usePersonPreferencesSync", () => {
  it("does nothing signed out, and never loads the sync", async () => {
    usePersonPreferencesSync(null);
    await settle();
    expect(moduleLoaded).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
    expect(cleanup).toBeUndefined();
  });

  it("does nothing while the platform is not ready, even signed in", async () => {
    flags.ready = false;
    usePersonPreferencesSync("user_1");
    await settle();
    expect(moduleLoaded).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });

  it("starts the sync for the signed-in person", async () => {
    usePersonPreferencesSync("user_1");
    await settle();
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(startMock).toHaveBeenCalledWith("user_1");
  });

  it("stops it when the person goes", async () => {
    usePersonPreferencesSync("user_1");
    await settle();
    cleanup?.();
    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it("never starts it if the person went before the code arrived", async () => {
    usePersonPreferencesSync("user_1");
    cleanup?.();
    await settle();
    expect(startMock).not.toHaveBeenCalled();
  });

  it("survives a sync that cannot be loaded", async () => {
    startMock.mockImplementation(() => {
      throw new Error("chunk failed");
    });
    usePersonPreferencesSync("user_1");
    await settle();
    expect(() => cleanup?.()).not.toThrow();
  });
});
