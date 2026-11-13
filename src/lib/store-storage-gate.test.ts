import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What the store hands the RxDB bridge, and when.
const bridge = vi.hoisted(() => ({
  updatePreferences: vi.fn(),
  initRxDBBridge: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./rxdb/bridge", () => bridge);
vi.mock("./rxdb/replication", () => ({
  startReplication: vi.fn().mockResolvedValue(undefined),
}));

import { _resetStartGate, releaseStorage } from "./rxdb/start-gate";

const { initializeDeviceSync } = await import("./store");

function at(pathname: string) {
  vi.stubGlobal("window", { location: { pathname } });
}

describe("the preferences database starts after the first screen on the home page", () => {
  beforeEach(() => {
    _resetStartGate();
    bridge.initRxDBBridge.mockClear();
  });
  afterEach(() => {
    _resetStartGate();
    vi.unstubAllGlobals();
  });

  it("on / it waits for the gate, then starts once", async () => {
    at("/");
    initializeDeviceSync();
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.initRxDBBridge).not.toHaveBeenCalled();
    releaseStorage();
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.initRxDBBridge).toHaveBeenCalledTimes(1);
  });

  it("on a place page it starts at once, in the same call", () => {
    at("/harare--ksy4dd1");
    initializeDeviceSync();
    expect(bridge.initRxDBBridge).toHaveBeenCalledTimes(1);
  });

  it("on any other page it starts at once", () => {
    for (const path of ["/locations", "/profile", "/explore", "/offline"]) {
      bridge.initRxDBBridge.mockClear();
      _resetStartGate();
      at(path);
      initializeDeviceSync();
      expect(bridge.initRxDBBridge, path).toHaveBeenCalledTimes(1);
    }
  });

  it("once the first screen has been let go, a later visit to / starts at once", () => {
    at("/");
    releaseStorage();
    initializeDeviceSync();
    expect(bridge.initRxDBBridge).toHaveBeenCalledTimes(1);
  });
});
