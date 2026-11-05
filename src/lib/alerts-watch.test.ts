import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  placeListeners: new Set<() => void>(),
  workerListeners: new Set<() => void>(),
  loads: [] as Array<{ slugs: readonly string[]; names: unknown }>,
  loadResults: [] as Array<() => unknown>,
  reports: new Map<string, readonly { reportedAt: string }[] | null>(),
  docListeners: new Map<string, () => void>(),
  visibility: "visible",
}));

vi.mock("./rxdb/bridge", () => ({
  updatePreferences: vi.fn(),
  initRxDBBridge: vi.fn().mockResolvedValue(undefined),
  getDeviceId: () => "test-device-id",
  migrateLocalStorageToRxDB: vi.fn().mockResolvedValue(undefined),
  _resetBridge: vi.fn(),
}));
vi.mock("./rxdb/replication", () => ({
  startReplication: vi.fn().mockResolvedValue(undefined),
  stopReplication: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./rxdb/weather-places", () => ({
  subscribePlaces: (fn: () => void) => {
    h.placeListeners.add(fn);
    return () => h.placeListeners.delete(fn);
  },
}));
vi.mock("./worker-data", () => ({
  workerData: {
    subscribe: (fn: () => void) => {
      h.workerListeners.add(fn);
      return () => h.workerListeners.delete(fn);
    },
  },
}));
vi.mock("./alerts-source", () => ({
  alertPlaceSlugs: (input: {
    selectedLocation?: string;
    savedLocations?: string[];
  }) =>
    [input.selectedLocation, ...(input.savedLocations ?? [])].filter(Boolean),
  peekReports: (slug: string) => h.reports.get(slug) ?? null,
  loadAlerts: async (slugs: readonly string[], names: unknown) => {
    h.loads.push({ slugs, names });
    const next = h.loadResults.shift();
    return next
      ? next()
      : {
          alerts: [],
          placesChecked: 0,
          placesTotal: 0,
          forecastUpdatedAt: null,
        };
  },
}));
vi.mock("./safe-storage", () => ({ readStorage: () => null }));

import { snapshotOf, watchAlerts, type AlertSnapshot } from "./alerts-watch";
import type { Alert, AlertsResult } from "./alerts";
import { DEFAULT_NOTIFICATION_PREFS } from "./notification-prefs";
import { useAppStore } from "./store";

const alert = (kind: Alert["kind"]): Alert => ({
  id: `harare:${kind}:advisory`,
  kind,
  level: "advisory",
  severity: "high",
  placeSlug: "harare",
  placeName: "Harare",
  headline: "h",
  message: "m",
  when: "w",
  asOf: "a",
  asOfMs: 0,
  source: "s",
});

const result = (alerts: Alert[]): AlertsResult => ({
  alerts,
  placesChecked: 1,
  placesTotal: 1,
  forecastUpdatedAt: 1,
});

describe("snapshotOf", () => {
  it("keeps only the kinds that are on, and reports quiet hours on the person's clock", () => {
    const all = [alert("frost"), alert("lightning")];
    const snap = snapshotOf(
      result(all),
      { ...DEFAULT_NOTIFICATION_PREFS, lightning: false },
      new Date(0),
    );
    expect(snap.result.alerts).toHaveLength(2);
    expect(snap.shown.map((a) => a.kind)).toEqual(["frost"]);
    expect(snap.quiet).toBe(false);
    expect(snap.at).toBe(0);

    // Quiet from 00:00 to 23:00 UTC-agnostic: choose the viewer-local hour.
    const now = new Date(2026, 6, 10, 23, 30); // 23:30 on this machine's clock
    expect(
      snapshotOf(
        result(all),
        { ...DEFAULT_NOTIFICATION_PREFS, quietStart: 22, quietEnd: 6 },
        now,
      ).quiet,
    ).toBe(true);
    expect(
      snapshotOf(
        result(all),
        { ...DEFAULT_NOTIFICATION_PREFS, quietStart: 22, quietEnd: 6 },
        new Date(2026, 6, 10, 12, 0),
      ).quiet,
    ).toBe(false);
  });
});

describe("watchAlerts: event driven, never polling", () => {
  const snaps: AlertSnapshot[] = [];
  let stop: () => void = () => undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    snaps.length = 0;
    h.placeListeners.clear();
    h.workerListeners.clear();
    h.loads.length = 0;
    h.loadResults.length = 0;
    h.reports.clear();
    h.docListeners.clear();
    h.visibility = "visible";
    (globalThis as unknown as { document: unknown }).document = {
      get visibilityState() {
        return h.visibility;
      },
      addEventListener: (name: string, fn: () => void) =>
        h.docListeners.set(name, fn),
      removeEventListener: (name: string) => h.docListeners.delete(name),
    };
    useAppStore.setState({
      selectedLocation: "harare",
      homeLocation: null,
      savedLocations: [],
      locationLabels: { harare: "Home" },
      locationNames: {},
      notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS },
    });
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
    delete (globalThis as unknown as { document?: unknown }).document;
  });

  const start = () => {
    stop = watchAlerts((s) => snaps.push(s), { debounceMs: 250 });
    return stop;
  };
  const flush = async () => {
    await vi.advanceTimersByTimeAsync(300);
  };

  it("reads once at the start, with the person's places and names, and tells the caller", async () => {
    h.loadResults.push(() => result([alert("frost")]));
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.loads).toHaveLength(1);
    expect(h.loads[0].slugs).toEqual(["harare"]);
    expect(h.loads[0].names).toEqual({
      labels: { harare: "Home" },
      names: {},
    });
    expect(snaps).toHaveLength(1);
    expect(snaps[0].shown.map((a) => a.kind)).toEqual(["frost"]);
  });

  it("does nothing between events: time passing alone reads nothing", async () => {
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.loads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(h.loads).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("looks again, once, after a place is stored (bursts are merged)", async () => {
    start();
    await vi.advanceTimersByTimeAsync(0);
    for (const fn of [...h.placeListeners]) {
      fn();
      fn();
      fn();
    }
    await flush();
    expect(h.loads).toHaveLength(2);
  });

  it("looks again when the person's places or alert choices change, but not for other state", async () => {
    start();
    await vi.advanceTimersByTimeAsync(0);
    useAppStore.setState({ theme: "dark" });
    useAppStore.setState({ myWeatherOpen: true });
    await flush();
    expect(h.loads).toHaveLength(1);

    useAppStore.setState({ savedLocations: ["mutare"] });
    await flush();
    expect(h.loads).toHaveLength(2);
    expect(h.loads[1].slugs).toEqual(["harare", "mutare"]);

    useAppStore.getState().setNotificationPrefs({ frost: false });
    await flush();
    expect(h.loads).toHaveLength(3);

    useAppStore.setState({ selectedLocation: "mutare" });
    await flush();
    expect(h.loads).toHaveLength(4);
  });

  it("looks again only when the held reports changed, not for every read that settles", async () => {
    start();
    await vi.advanceTimersByTimeAsync(0);
    for (const fn of [...h.workerListeners]) fn(); // some unrelated read
    await flush();
    expect(h.loads).toHaveLength(1);

    h.reports.set("harare", [{ reportedAt: "2026-07-10T10:00:00Z" }]);
    for (const fn of [...h.workerListeners]) fn();
    await flush();
    expect(h.loads).toHaveLength(2);

    // The same reports again: nothing new.
    for (const fn of [...h.workerListeners]) fn();
    await flush();
    expect(h.loads).toHaveLength(2);
  });

  it("looks again when the tab becomes visible, not while hidden", async () => {
    start();
    await vi.advanceTimersByTimeAsync(0);
    h.visibility = "hidden";
    h.docListeners.get("visibilitychange")?.();
    await flush();
    expect(h.loads).toHaveLength(1);
    h.visibility = "visible";
    h.docListeners.get("visibilitychange")?.();
    await flush();
    expect(h.loads).toHaveLength(2);
  });

  it("lets only the latest read speak", async () => {
    let releaseFirst: (v: AlertsResult) => void = () => undefined;
    h.loadResults.push(
      () =>
        new Promise<AlertsResult>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    h.loadResults.push(() => result([alert("lightning")]));
    start();
    await vi.advanceTimersByTimeAsync(0); // first read is under way
    for (const fn of [...h.placeListeners]) fn();
    await flush(); // second read finishes first
    expect(snaps.map((s) => s.shown.map((a) => a.kind))).toEqual([
      ["lightning"],
    ]);
    releaseFirst(result([alert("frost")])); // the older answer arrives late
    await vi.advanceTimersByTimeAsync(0);
    expect(snaps).toHaveLength(1);
  });

  it("stops listening and speaking once stopped", async () => {
    start();
    await vi.advanceTimersByTimeAsync(0);
    stop();
    expect(h.placeListeners.size).toBe(0);
    expect(h.workerListeners.size).toBe(0);
    expect(h.docListeners.size).toBe(0);
    useAppStore.setState({ savedLocations: ["mutare"] });
    await flush();
    expect(h.loads).toHaveLength(1);
  });

  it("a read that fails leaves the last snapshot and does not throw", async () => {
    h.loadResults.push(() => {
      throw new Error("IndexedDB blocked");
    });
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(snaps).toEqual([]);
  });
});
