/**
 * The legacy device-profile pull (`/v1/devices`) and the person-preferences
 * sync (#484) both write `selectedActivities`. While the person sync is running
 * for a signed-in person the pull must leave the device's activities alone, and
 * only those: everything else it pulls is unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const captured = vi.hoisted(() => ({
  pull: null as
    | null
    | (() => Promise<{ documents: Record<string, unknown>[] }>),
}));
vi.mock("rxdb/plugins/replication", () => ({
  replicateRxCollection: (options: {
    pull: { handler: () => Promise<{ documents: Record<string, unknown>[] }> };
  }) => {
    captured.pull = options.pull.handler;
    return { cancel: async () => undefined };
  },
}));

const localDoc = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));
vi.mock("./collections", () => ({
  preferencesCollection: async () => ({
    findOne: () => ({ exec: async () => localDoc.current }),
  }),
  suitabilityRulesCollection: async () => null,
}));
vi.mock("./bridge", () => ({ getDeviceId: () => "device-1" }));
vi.mock("../weather-api", () => ({
  fetchWorker: async () => new Response("", { status: 404 }),
}));

const serverProfile = vi.hoisted(() => ({
  preferences: {
    theme: "dark",
    selectedLocation: "harare",
    savedLocations: ["harare"],
    locationLabels: {},
    selectedActivities: ["from-the-server"],
    hasOnboarded: true,
    selectedForecastModel: "best_match",
  },
}));
vi.mock("./device-profile", () => ({
  createDeviceProfileClient: () => ({
    push: async () => undefined,
    pull: async () => serverProfile,
  }),
}));

import { startReplication, stopReplication } from "./replication";
import { setPersonSyncActive } from "../person-preferences-state";

async function pull() {
  expect(captured.pull).not.toBeNull();
  const out = await captured.pull!();
  return out.documents[0];
}

beforeEach(async () => {
  vi.useFakeTimers();
  captured.pull = null;
  setPersonSyncActive(false);
  localDoc.current = {
    id: "device-1",
    selectedActivities: ["chosen-here-1", "chosen-here-2"],
    homeLocation: "bulawayo",
    hiddenPresetSlugs: [],
    presetAnchor: null,
  };
  await startReplication();
});

afterEach(async () => {
  await stopReplication();
  setPersonSyncActive(false);
  vi.useRealTimers();
});

describe("the legacy device-profile pull and the person sync", () => {
  it("takes the profile's activities as before while the person sync is not running", async () => {
    const doc = await pull();
    expect(doc.selectedActivities).toEqual(["from-the-server"]);
  });

  it("leaves the device's own activities alone while the person sync is running", async () => {
    setPersonSyncActive(true);
    const doc = await pull();
    expect(doc.selectedActivities).toEqual(["chosen-here-1", "chosen-here-2"]);
  });

  it("changes nothing else it pulls", async () => {
    setPersonSyncActive(true);
    const doc = await pull();
    expect(doc).toMatchObject({
      id: "device-1",
      theme: "dark",
      selectedLocation: "harare",
      savedLocations: ["harare"],
      hasOnboarded: true,
      homeLocation: "bulawayo",
    });
  });

  it("falls back to the profile's list when the device has no document yet", async () => {
    setPersonSyncActive(true);
    localDoc.current = null;
    const doc = await pull();
    expect(doc.selectedActivities).toEqual(["from-the-server"]);
  });

  it("is back to the old behaviour once the person sync stops", async () => {
    setPersonSyncActive(true);
    setPersonSyncActive(false);
    const doc = await pull();
    expect(doc.selectedActivities).toEqual(["from-the-server"]);
  });
});
