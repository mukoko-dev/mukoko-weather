/**
 * The browser wiring: nothing is read before the device's own preferences have
 * loaded, the first request waits for first paint, a change goes out a moment
 * after the person makes it, and stopping really stops. The store and storage
 * are stand-ins; the rules themselves are in person-preferences-sync.test.ts
 * and the gate (signed in, switch on) in use-person-preferences-sync.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let stop: (() => void) | void;

const hydration = vi.hoisted(() => ({
  hydrated: true,
  listeners: new Set<() => void>(),
}));
const storeState = vi.hoisted(() => ({
  selectedActivities: [] as string[],
  listeners: new Set<(s: unknown, p: unknown) => void>(),
}));
const applySynced = vi.hoisted(() => vi.fn());
vi.mock("./store", () => ({
  hasStoreHydrated: () => hydration.hydrated,
  subscribeStoreHydrated: (l: () => void) => {
    hydration.listeners.add(l);
    return () => hydration.listeners.delete(l);
  },
  applySyncedPreferences: applySynced,
  useAppStore: {
    getState: () => ({ selectedActivities: storeState.selectedActivities }),
    subscribe: (l: (s: unknown, p: unknown) => void) => {
      storeState.listeners.add(l);
      return () => storeState.listeners.delete(l);
    },
  },
}));

import {
  PERSON_SYNC_STATE_KEY,
  parseSyncState,
  startPersonPreferencesSync,
} from "./person-preferences-sync-start";
import { ACT, ACT2, T2, activity } from "./person-preferences-fixtures";

const fetchMock = vi.fn();
const storage = new Map<string, string>();
const windowListeners = new Map<string, () => void>();

beforeEach(() => {
  vi.useFakeTimers();
  hydration.hydrated = true;
  hydration.listeners.clear();
  storeState.selectedActivities = [ACT];
  storeState.listeners.clear();
  applySynced.mockReset();
  fetchMock.mockReset();
  // An empty profile that keeps what it is sent.
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    const sent = init.body ? JSON.parse(String(init.body)).activities : [];
    return new Response(
      JSON.stringify({
        schemaVersion: "v3.1",
        settings: {},
        activities: sent,
        savedPlaces: [],
      }),
    );
  });
  storage.clear();
  windowListeners.clear();
  stop = undefined;
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: number) => clearTimeout(h),
    addEventListener: (name: string, fn: () => void) =>
      windowListeners.set(name, fn),
    removeEventListener: (name: string) => windowListeners.delete(name),
  });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
});

afterEach(() => {
  stop?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("startPersonPreferencesSync", () => {
  it("waits for first paint, then reads the profile and sends what is new", async () => {
    stop = startPersonPreferencesSync("user_1");
    await vi.advanceTimersByTimeAsync(2_900);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchMock.mock.calls.map((c) => c[1].method)).toEqual([
      "GET",
      "PUT",
    ]);
    const view = parseSyncState(storage.get(PERSON_SYNC_STATE_KEY) ?? null);
    expect(view?.owner).toBe("user_1");
    expect(view?.activities.map((a) => a.activityId)).toEqual([ACT]);
  });

  it("does not read the device's list before its preferences have loaded", async () => {
    hydration.hydrated = false;
    stop = startPersonPreferencesSync("user_1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
    for (const l of hydration.listeners) l();
    await vi.advanceTimersByTimeAsync(3_100);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("sends a change a moment after the person makes it, not for the app's own writes", async () => {
    stop = startPersonPreferencesSync("user_1");
    await vi.advanceTimersByTimeAsync(3_100);
    fetchMock.mockClear();

    const next = [ACT, ACT2];
    const prev = { selectedActivities: [ACT] };
    for (const l of storeState.listeners) l({ selectedActivities: next }, prev);
    await vi.advanceTimersByTimeAsync(1_900);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchMock).toHaveBeenCalled();

    // The same list set again (RxDB re-emitting) is not a change.
    fetchMock.mockClear();
    for (const l of storeState.listeners) {
      l(
        { selectedActivities: [ACT, ACT2] },
        { selectedActivities: [ACT, ACT2] },
      );
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applies the profile's activities through the store's own setter", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            activities: [activity({ activityId: ACT2 })],
            savedPlaces: [],
          }),
        ),
    );
    storeState.selectedActivities = [];
    stop = startPersonPreferencesSync("user_1");
    await vi.advanceTimersByTimeAsync(3_100);
    expect(applySynced).toHaveBeenCalledWith({ selectedActivities: [ACT2] });
  });

  it("stops listening when the person signs out (the unmount)", async () => {
    stop = startPersonPreferencesSync("user_1");
    expect(storeState.listeners.size).toBe(1);
    stop?.();
    expect(storeState.listeners.size).toBe(0);
    expect(windowListeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops for the page when the server says it is not ready", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ code: "preferences_unavailable" }), {
          status: 503,
        }),
    );
    stop = startPersonPreferencesSync("user_1");
    await vi.advanceTimersByTimeAsync(3_100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const l of storeState.listeners) {
      l({ selectedActivities: [ACT, ACT2] }, { selectedActivities: [ACT] });
    }
    windowListeners.get("online")?.();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("when storage cannot keep the view (a private window, a full quota)", () => {
  it("keeps it in memory for the page, so a re-added item is a revive, not a brand-new add", async () => {
    // The profile removed ACT. This device has no view yet.
    const removed = activity({
      activityId: ACT,
      updatedAt: T2,
      tombstone: true,
    });
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const sent = init.body ? JSON.parse(String(init.body)).activities : [];
      const items = [removed];
      for (const s of sent) {
        const i = items.findIndex((x) => x.activityId === s.activityId);
        if (i < 0) items.push(s);
        else if (s.updatedAt > items[i].updatedAt) items[i] = s;
      }
      return new Response(
        JSON.stringify({
          schemaVersion: "v3.1",
          settings: {},
          activities: items,
          savedPlaces: [],
        }),
      );
    });
    // Storage throws on every write; the store stand-in applies what it is told.
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => undefined,
    });
    applySynced.mockImplementation((p: { selectedActivities: string[] }) => {
      storeState.selectedActivities = p.selectedActivities;
    });
    storeState.selectedActivities = [ACT];

    stop = startPersonPreferencesSync("user_1");
    await vi.advanceTimersByTimeAsync(3_100);
    // First pass: nothing on this device saw the removal, so it stands.
    expect(storeState.selectedActivities).toEqual([]);

    // The person picks it again.
    fetchMock.mockClear();
    const prev = { selectedActivities: [] as string[] };
    storeState.selectedActivities = [ACT];
    for (const l of storeState.listeners) {
      l({ selectedActivities: [ACT] }, prev);
    }
    await vi.advanceTimersByTimeAsync(2_100);
    const put = fetchMock.mock.calls.find((c) => c[1].method === "PUT");
    expect(put).toBeDefined();
    expect(JSON.parse(String(put?.[1].body)).activities).toEqual([
      expect.objectContaining({ activityId: ACT, tombstone: false }),
    ]);
    expect(storeState.selectedActivities).toEqual([ACT]);
  });
});

describe("parseSyncState", () => {
  it("reads what the module wrote and nothing else", () => {
    const good = JSON.stringify({ owner: "user_1", activities: [activity()] });
    expect(parseSyncState(good)).toEqual({
      owner: "user_1",
      activities: [activity()],
    });
    expect(parseSyncState(null)).toBeNull();
    expect(parseSyncState("not json")).toBeNull();
    expect(parseSyncState(JSON.stringify({ activities: [] }))).toBeNull();
    expect(
      parseSyncState(JSON.stringify({ owner: "", activities: [] })),
    ).toBeNull();
    expect(
      parseSyncState(
        JSON.stringify({ owner: "x".repeat(200), activities: [] }),
      ),
    ).toBeNull();
    expect(parseSyncState("x".repeat(70_000))).toBeNull();
  });

  it("keeps a well-formed syncedAt and drops any other", () => {
    const at = "2026-11-04T09:00:00.000Z";
    expect(
      parseSyncState(
        JSON.stringify({ owner: "u", activities: [], syncedAt: at }),
      )?.syncedAt,
    ).toBe(at);
    expect(
      parseSyncState(
        JSON.stringify({ owner: "u", activities: [], syncedAt: "yesterday" }),
      ),
    ).toEqual({ owner: "u", activities: [] });
  });

  it("drops entries that are not activities", () => {
    const state = parseSyncState(
      JSON.stringify({
        owner: "u",
        activities: [activity(), { activityId: 3 }, "x"],
      }),
    );
    expect(state?.activities).toEqual([activity()]);
  });
});
