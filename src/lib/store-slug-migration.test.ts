import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture what the store hands the RxDB bridge, and every write it makes.
const bridge = vi.hoisted(() => ({
  updatePreferences: vi.fn(),
  initRxDBBridge: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./rxdb/bridge", () => bridge);
vi.mock("./rxdb/replication", () => ({
  startReplication: vi.fn().mockResolvedValue(undefined),
}));

import { canonicalSlug as c } from "./slug-migration";

const { useAppStore, initializeDeviceSync } = await import("./store");

type Callbacks = {
  applyToStore: (prefs: Record<string, unknown>) => void;
};

function callbacks(): Callbacks {
  initializeDeviceSync();
  return bridge.initRxDBBridge.mock.calls.at(-1)![0] as Callbacks;
}

describe("saved slugs migrate once when preferences reach the store (#317)", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
    bridge.updatePreferences.mockClear();
    bridge.initRxDBBridge.mockClear();
    useAppStore.setState({
      selectedLocation: "",
      savedLocations: [],
      homeLocation: null,
      hiddenPresetSlugs: [],
      locationLabels: {},
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const legacy = {
    selectedLocation: "harare",
    savedLocations: ["bulawayo", "harare", "x--ksy4dd7"],
    homeLocation: "nairobi-ke",
    hiddenPresetSlugs: ["gweru"],
    locationLabels: { harare: "Home" },
  };

  it("canonicalises every slug field and writes the result back", () => {
    callbacks().applyToStore(legacy);
    const s = useAppStore.getState();
    expect(s.selectedLocation).toBe(c("harare"));
    expect(s.savedLocations).toEqual([
      c("bulawayo"),
      c("harare"),
      "x--ksy4dd7",
    ]);
    expect(s.homeLocation).toBe(c("nairobi-ke"));
    expect(s.hiddenPresetSlugs).toEqual([c("gweru")]);
    expect(s.locationLabels).toEqual({ [c("harare")]: "Home" });
    // RxDB (and through it the device profile) follows, in one write.
    expect(bridge.updatePreferences).toHaveBeenCalledTimes(1);
    expect(bridge.updatePreferences).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedLocation: c("harare"),
        savedLocations: [c("bulawayo"), c("harare"), "x--ksy4dd7"],
        homeLocation: c("nairobi-ke"),
      }),
    );
  });

  it("is idempotent: the write-back re-enters with nothing left to migrate", () => {
    const { applyToStore } = callbacks();
    applyToStore(legacy);
    bridge.updatePreferences.mockClear();
    const after = useAppStore.getState();
    applyToStore({
      selectedLocation: after.selectedLocation,
      savedLocations: after.savedLocations,
      homeLocation: after.homeLocation,
      hiddenPresetSlugs: after.hiddenPresetSlugs,
      locationLabels: after.locationLabels,
    });
    expect(bridge.updatePreferences).not.toHaveBeenCalled();
    expect(useAppStore.getState()).toMatchObject({
      selectedLocation: c("harare"),
      savedLocations: [c("bulawayo"), c("harare"), "x--ksy4dd7"],
    });
  });

  it("writes nothing for preferences that carry no legacy slug", () => {
    callbacks().applyToStore({
      selectedLocation: "x--ksy4dd7",
      savedLocations: ["x--ksy4dd7"],
    });
    expect(bridge.updatePreferences).not.toHaveBeenCalled();
  });
});
