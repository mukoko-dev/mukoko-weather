import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BridgeCallbacks } from "./bridge";

// ---------------------------------------------------------------------------
// Mock localStorage (Node has no DOM)
// ---------------------------------------------------------------------------

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
})();

Object.defineProperty(globalThis, "localStorage", { value: localStorageMock });

// initRxDBBridge guards on `typeof window !== "undefined"` — provide a stub
if (typeof globalThis.window === "undefined") {
  Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
}

// ---------------------------------------------------------------------------
// Mock RxDB collections — must be hoisted before bridge import
// ---------------------------------------------------------------------------

const mockFindOneExec = vi.fn();
const mockUpsert = vi.fn();
const mockPatch = vi.fn();
const mockSubscribe = vi.fn(() => ({ unsubscribe: vi.fn() }));

let _mockCollectionReturnNull = false;

vi.mock("./collections", () => ({
  preferencesCollection: vi.fn(async () => {
    if (_mockCollectionReturnNull) return null;
    return {
      findOne: (id: string) => ({
        exec: () => mockFindOneExec(id),
        $: { subscribe: mockSubscribe },
      }),
      upsert: mockUpsert,
    };
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCallbacks(overrides?: Partial<BridgeCallbacks>): BridgeCallbacks {
  return {
    applyToStore: vi.fn(),
    getCurrentPrefs: vi.fn(() => ({
      theme: "system",
      selectedLocation: "",
      savedLocations: [],
      locationLabels: {},
      selectedActivities: [],
      hasOnboarded: false,
    })),
    ...overrides,
  };
}

const LEGACY_KEY = "mukoko-weather-prefs";

function setLegacyPrefs(state: Record<string, unknown>) {
  localStorageMock.setItem(LEGACY_KEY, JSON.stringify({ state }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bridge — getDeviceId", () => {
  beforeEach(async () => {
    localStorageMock.clear();
    const bridge = await import("./bridge");
    bridge._resetBridge();
    vi.clearAllMocks();
  });

  it("generates and persists a device ID", async () => {
    const { getDeviceId } = await import("./bridge");
    const id1 = getDeviceId();
    expect(id1).toBeTruthy();
    expect(localStorageMock.getItem("mukoko-device-id")).toBe(id1);
  });

  it("returns the same ID on subsequent calls", async () => {
    const { getDeviceId } = await import("./bridge");
    const id1 = getDeviceId();
    const id2 = getDeviceId();
    expect(id1).toBe(id2);
  });

  it("reads existing ID from localStorage", async () => {
    localStorageMock.setItem("mukoko-device-id", "existing-id");
    const { getDeviceId, _resetBridge } = await import("./bridge");
    _resetBridge();
    const id = getDeviceId();
    expect(id).toBe("existing-id");
  });
});

describe("bridge — migrateLocalStorageToRxDB", () => {
  beforeEach(async () => {
    localStorageMock.clear();
    const bridge = await import("./bridge");
    bridge._resetBridge();
    vi.clearAllMocks();
    mockFindOneExec.mockResolvedValue(null);
    mockUpsert.mockResolvedValue(undefined);
  });

  it("migrates legacy prefs to RxDB and cleans up localStorage", async () => {
    setLegacyPrefs({
      theme: "dark",
      selectedLocation: "harare",
      savedLocations: ["harare", "bulawayo"],
      selectedActivities: ["running"],
      hasOnboarded: true,
    });

    const { migrateLocalStorageToRxDB } = await import("./bridge");
    await migrateLocalStorageToRxDB();

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: "dark",
        selectedLocation: "harare",
        savedLocations: ["harare", "bulawayo"],
        selectedActivities: ["running"],
        hasOnboarded: true,
      }),
    );

    // Legacy key should be removed
    expect(localStorageMock.getItem(LEGACY_KEY)).toBeNull();
  });

  it("skips migration when RxDB already has data (no double-write)", async () => {
    setLegacyPrefs({ theme: "light" });
    mockFindOneExec.mockResolvedValue({ theme: "light" }); // existing doc

    const { migrateLocalStorageToRxDB } = await import("./bridge");
    await migrateLocalStorageToRxDB();

    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("no-ops when no legacy data exists", async () => {
    const { migrateLocalStorageToRxDB } = await import("./bridge");
    await migrateLocalStorageToRxDB();

    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("cleans up legacy weather hint keys", async () => {
    setLegacyPrefs({ theme: "system" });
    localStorageMock.setItem("mukoko-weather-hint:harare", '{"sceneType":"rain"}');
    localStorageMock.setItem("mukoko-weather-hint:bulawayo", '{"sceneType":"clear"}');
    localStorageMock.setItem("unrelated-key", "keep");

    const { migrateLocalStorageToRxDB } = await import("./bridge");
    await migrateLocalStorageToRxDB();

    expect(localStorageMock.getItem("mukoko-weather-hint:harare")).toBeNull();
    expect(localStorageMock.getItem("mukoko-weather-hint:bulawayo")).toBeNull();
    expect(localStorageMock.getItem("unrelated-key")).toBe("keep");
  });

  it("defaults missing fields during migration", async () => {
    setLegacyPrefs({ theme: "dark" }); // only theme present

    const { migrateLocalStorageToRxDB } = await import("./bridge");
    await migrateLocalStorageToRxDB();

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: "dark",
        selectedLocation: "",
        savedLocations: [],
        locationLabels: {},
        selectedActivities: [],
        hasOnboarded: false,
      }),
    );
  });
});

describe("bridge — initRxDBBridge", () => {
  beforeEach(async () => {
    localStorageMock.clear();
    const bridge = await import("./bridge");
    bridge._resetBridge();
    vi.clearAllMocks();
    mockFindOneExec.mockResolvedValue(null);
    mockUpsert.mockResolvedValue(undefined);
  });

  it("hydrates Zustand from RxDB when doc exists", async () => {
    const storedDoc = {
      theme: "dark",
      selectedLocation: "nairobi-ke",
      savedLocations: ["nairobi-ke"],
      locationLabels: { "nairobi-ke": "Nairobi" },
      selectedActivities: ["safari"],
      hasOnboarded: true,
    };
    mockFindOneExec.mockResolvedValue(storedDoc);

    const callbacks = makeCallbacks();
    const { initRxDBBridge } = await import("./bridge");
    await initRxDBBridge(callbacks);

    expect(callbacks.applyToStore).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: "dark",
        selectedLocation: "nairobi-ke",
        hasOnboarded: true,
      }),
    );
  });

  it("seeds RxDB from current Zustand when no doc exists", async () => {
    mockFindOneExec.mockResolvedValue(null);

    const callbacks = makeCallbacks({
      getCurrentPrefs: vi.fn(() => ({
        theme: "light",
        selectedLocation: "harare",
        savedLocations: ["harare"],
        locationLabels: {},
        selectedActivities: ["farming"],
        hasOnboarded: true,
      })),
    });

    const { initRxDBBridge } = await import("./bridge");
    await initRxDBBridge(callbacks);

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: "light",
        selectedLocation: "harare",
        selectedActivities: ["farming"],
      }),
    );
  });

  it("only initializes once (idempotent)", async () => {
    mockFindOneExec.mockResolvedValue({ theme: "system" });
    const callbacks = makeCallbacks();

    const { initRxDBBridge } = await import("./bridge");
    await initRxDBBridge(callbacks);
    await initRxDBBridge(callbacks);

    // applyToStore called once from hydration, not doubled from a second init
    expect(callbacks.applyToStore).toHaveBeenCalledTimes(1);
  });
});

describe("bridge — updatePreferences", () => {
  beforeEach(async () => {
    localStorageMock.clear();
    const bridge = await import("./bridge");
    bridge._resetBridge();
    vi.clearAllMocks();
  });

  it("patches existing doc with updates", async () => {
    const mockDoc = { patch: mockPatch };
    mockFindOneExec.mockResolvedValue(mockDoc);

    const { updatePreferences, getDeviceId } = await import("./bridge");
    getDeviceId(); // ensure device ID is set
    await updatePreferences({ theme: "dark" });

    expect(mockPatch).toHaveBeenCalledWith(
      expect.objectContaining({ theme: "dark", updatedAt: expect.any(Number) }),
    );
  });

  it("upserts new doc when none exists", async () => {
    mockFindOneExec.mockResolvedValue(null);

    const { updatePreferences, getDeviceId } = await import("./bridge");
    getDeviceId(); // ensure device ID is set
    await updatePreferences({ theme: "light", hasOnboarded: true });

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: "light",
        hasOnboarded: true,
        updatedAt: expect.any(Number),
      }),
    );
  });
});

describe("bridge — initRxDBBridge retry on null collection", () => {
  beforeEach(async () => {
    localStorageMock.clear();
    _mockCollectionReturnNull = false;
    const bridge = await import("./bridge");
    bridge._resetBridge();
    vi.clearAllMocks();
  });

  it("allows retry when preferencesCollection returns null", async () => {
    _mockCollectionReturnNull = true;
    const callbacks = makeCallbacks();
    const { initRxDBBridge } = await import("./bridge");

    // First call — collection unavailable, should not permanently block
    await initRxDBBridge(callbacks);
    expect(callbacks.applyToStore).not.toHaveBeenCalled();

    // Now collection becomes available
    _mockCollectionReturnNull = false;
    mockFindOneExec.mockResolvedValue({ theme: "dark", selectedLocation: "harare", savedLocations: [], locationLabels: {}, selectedActivities: [], hasOnboarded: true });

    // Second call should succeed
    await initRxDBBridge(callbacks);
    expect(callbacks.applyToStore).toHaveBeenCalledWith(
      expect.objectContaining({ theme: "dark" }),
    );
  });
});

describe("bridge — _resetBridge", () => {
  it("allows re-initialization after reset", async () => {
    localStorageMock.clear();
    const { _resetBridge, initRxDBBridge } = await import("./bridge");
    _resetBridge();
    mockFindOneExec.mockResolvedValue({ theme: "system" });
    const callbacks = makeCallbacks();

    await initRxDBBridge(callbacks);
    _resetBridge();

    // Should be able to init again after reset
    const callbacks2 = makeCallbacks();
    await initRxDBBridge(callbacks2);
    expect(callbacks2.applyToStore).toHaveBeenCalled();
  });
});
