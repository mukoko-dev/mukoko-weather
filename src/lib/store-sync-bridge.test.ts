/**
 * What the CouchDB sync is told about the app's state (#396): a change is a
 * difference in VALUE, and it says where it came from.
 *
 * The app's RxDB preferences bridge sets a fresh array into the store on every
 * emission of the preferences document (a place switch, a `/v1/devices` pull,
 * another tab). Compared by reference, each of those was a "change the person
 * made": the setting was re-stamped with the current time (beating a newer
 * value from another device) and the unwritten-change record was written on
 * every place switch. And a value that arrived from the device-profile pull
 * (which sends `selectedActivities: []` for a profile with none) looked like
 * the person removing every activity.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeCallbacks } from "./rxdb/bridge";

const bridgeMock = vi.hoisted(() => ({
  callbacks: null as BridgeCallbacks | null,
}));

vi.mock("./rxdb/bridge", () => ({
  updatePreferences: vi.fn(),
  initRxDBBridge: vi.fn(async (cb: BridgeCallbacks) => {
    bridgeMock.callbacks = cb;
  }),
  getDeviceId: () => "test-device-id",
  migrateLocalStorageToRxDB: vi.fn().mockResolvedValue(undefined),
  _resetBridge: vi.fn(),
}));

vi.mock("./rxdb/replication", () => ({
  startReplication: vi.fn().mockResolvedValue(undefined),
  stopReplication: vi.fn().mockResolvedValue(undefined),
}));

import { createSyncBridge, initializeDeviceSync, useAppStore } from "./store";

beforeEach(async () => {
  vi.stubGlobal("window", {});
  useAppStore.setState({
    theme: "system",
    selectedForecastModel: "best_match",
    selectedActivities: ["livestock", "gardening"],
    selectedLocation: "harare",
  });
  initializeDeviceSync();
  await new Promise((r) => setTimeout(r, 0));
});

function listening() {
  const bridge = createSyncBridge();
  const heard: (string | undefined)[] = [];
  const stop = bridge.subscribe((origin) => heard.push(origin));
  return { bridge, heard, stop };
}

describe("read", () => {
  it("is the three settings, with an array of its own", () => {
    const { bridge } = listening();
    const read = bridge.read();
    expect(Object.keys(read).sort()).toEqual([
      "selectedActivities",
      "selectedForecastModel",
      "theme",
    ]);
    expect(read.selectedActivities).toEqual(["livestock", "gardening"]);
    expect(read.selectedActivities).not.toBe(
      useAppStore.getState().selectedActivities,
    );
  });
});

describe("a change is a difference in VALUE", () => {
  it("the same activities in a new array (what the preferences bridge sets on every emission) are not a change", () => {
    const { heard } = listening();
    useAppStore.setState({ selectedActivities: ["livestock", "gardening"] });
    useAppStore.setState({ selectedActivities: ["livestock", "gardening"] });
    expect(heard).toEqual([]);
  });

  it("another place selected, or any other setting, is not a synced change", () => {
    const { heard } = listening();
    useAppStore.getState().setSelectedLocation("bulawayo");
    useAppStore.setState({ hasOnboarded: true });
    expect(heard).toEqual([]);
  });

  it("the same theme or model set again is not a change", () => {
    const { heard } = listening();
    useAppStore.setState({
      theme: "system",
      selectedForecastModel: "best_match",
    });
    expect(heard).toEqual([]);
  });

  it("a different set, a different order, a different theme or model is one, from the person", () => {
    const { heard } = listening();
    useAppStore.setState({ selectedActivities: ["livestock"] });
    useAppStore.setState({ selectedActivities: ["livestock", "gardening"] });
    useAppStore.setState({ selectedActivities: ["gardening", "livestock"] });
    useAppStore.setState({ theme: "dark" });
    useAppStore.setState({ selectedForecastModel: "icon_global" });
    expect(heard).toEqual(["person", "person", "person", "person", "person"]);
  });

  it("an edit in the app (toggle) is one", () => {
    const { heard } = listening();
    useAppStore.getState().toggleActivity("farming");
    expect(heard).toEqual(["person"]);
  });
});

describe("where a change came from", () => {
  it("a value applied from the app's own preferences (a /v1/devices pull, another tab) says so, and is not the person's edit", () => {
    const { heard } = listening();
    // The device-profile pull for a profile with no activities.
    bridgeMock.callbacks?.applyToStore({ selectedActivities: [] });
    expect(heard).toEqual(["applied"]);
    expect(useAppStore.getState().selectedActivities).toEqual([]);
  });

  it("the same value re-applied from the preferences document is no event at all", () => {
    const { heard } = listening();
    bridgeMock.callbacks?.applyToStore({
      theme: "system",
      selectedActivities: ["livestock", "gardening"],
    });
    expect(heard).toEqual([]);
  });

  it("an edit made right after an apply is the person's again (the origin does not stick)", () => {
    const { heard } = listening();
    bridgeMock.callbacks?.applyToStore({ selectedActivities: ["farming"] });
    useAppStore.getState().toggleActivity("gardening");
    expect(heard).toEqual(["applied", "person"]);
  });

  it("stops listening when asked", () => {
    const { heard, stop } = listening();
    stop();
    useAppStore.setState({ theme: "dark" });
    expect(heard).toEqual([]);
  });
});
