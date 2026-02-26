import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getDeviceId,
  readLocalStoragePrefs,
  createDeviceProfile,
  fetchDeviceProfile,
  syncPreferences,
  DeviceSyncError,
  queueSync,
  _resetDeviceSync,
} from "./device-sync";

// ---------------------------------------------------------------------------
// Mock localStorage
// ---------------------------------------------------------------------------

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();

Object.defineProperty(globalThis, "localStorage", { value: localStorageMock });

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
Object.defineProperty(globalThis, "fetch", { value: mockFetch, writable: true });

beforeEach(() => {
  localStorageMock.clear();
  mockFetch.mockReset();
  _resetDeviceSync();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Device ID management
// ---------------------------------------------------------------------------

describe("getDeviceId", () => {
  it("returns null when no device ID is stored", () => {
    expect(getDeviceId()).toBeNull();
  });

  it("returns stored device ID", () => {
    localStorageMock.setItem("mukoko-device-id", "test-uuid-123");
    expect(getDeviceId()).toBe("test-uuid-123");
  });
});

// ---------------------------------------------------------------------------
// localStorage migration
// ---------------------------------------------------------------------------

describe("readLocalStoragePrefs", () => {
  it("returns null when no stored prefs exist", () => {
    expect(readLocalStoragePrefs()).toBeNull();
  });

  it("reads existing Zustand persisted preferences", () => {
    const stored = {
      state: {
        theme: "dark",
        selectedLocation: "bulawayo",
        selectedActivities: ["running", "hiking"],
        hasOnboarded: true,
      },
    };
    localStorageMock.setItem("mukoko-weather-prefs", JSON.stringify(stored));

    const result = readLocalStoragePrefs();
    expect(result).toEqual({
      theme: "dark",
      selectedLocation: "bulawayo",
      savedLocations: [],
      locationLabels: {},
      selectedActivities: ["running", "hiking"],
      hasOnboarded: true,
    });
  });

  it("provides defaults for missing fields", () => {
    const stored = { state: { theme: "light" } };
    localStorageMock.setItem("mukoko-weather-prefs", JSON.stringify(stored));

    const result = readLocalStoragePrefs();
    expect(result).toEqual({
      theme: "light",
      selectedLocation: "harare",
      savedLocations: [],
      locationLabels: {},
      selectedActivities: [],
      hasOnboarded: false,
    });
  });

  it("returns null for invalid JSON", () => {
    localStorageMock.setItem("mukoko-weather-prefs", "not-json");
    expect(readLocalStoragePrefs()).toBeNull();
  });

  it("returns null for JSON without state key", () => {
    localStorageMock.setItem("mukoko-weather-prefs", JSON.stringify({ version: 1 }));
    expect(readLocalStoragePrefs()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// API operations
// ---------------------------------------------------------------------------

describe("createDeviceProfile", () => {
  it("sends POST request with correct body", async () => {
    const profile = {
      deviceId: "abc-123",
      preferences: { theme: "dark", selectedLocation: "harare", savedLocations: [], selectedActivities: [], hasOnboarded: false },
      createdAt: "2026-02-22T00:00:00Z",
      updatedAt: "2026-02-22T00:00:00Z",
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(profile),
    });

    const result = await createDeviceProfile("abc-123", {
      theme: "dark",
      selectedLocation: "harare",
      savedLocations: [],
      locationLabels: {},
      selectedActivities: [],
      hasOnboarded: false,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/py/devices",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
    );
    expect(result.deviceId).toBe("abc-123");
  });

  it("throws DeviceSyncError on API failure", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ detail: "Invalid theme" }),
    });

    await expect(
      createDeviceProfile("abc-123", {
        theme: "invalid",
        selectedLocation: "harare",
        savedLocations: [],
        locationLabels: {},
        selectedActivities: [],
        hasOnboarded: false,
      }),
    ).rejects.toThrow(DeviceSyncError);
  });
});

describe("fetchDeviceProfile", () => {
  it("returns profile on success", async () => {
    const profile = {
      deviceId: "abc-123",
      preferences: { theme: "system", selectedLocation: "harare", savedLocations: [], selectedActivities: [], hasOnboarded: false },
      createdAt: "2026-02-22T00:00:00Z",
      updatedAt: "2026-02-22T00:00:00Z",
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(profile),
    });

    const result = await fetchDeviceProfile("abc-123");
    expect(result).toEqual(profile);
  });

  it("returns null on 404", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ detail: "Not found" }),
    });

    const result = await fetchDeviceProfile("nonexistent");
    expect(result).toBeNull();
  });

  it("throws on other errors", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ detail: "Server error" }),
    });

    await expect(fetchDeviceProfile("abc-123")).rejects.toThrow(DeviceSyncError);
  });
});

describe("syncPreferences", () => {
  it("sends PATCH with partial updates", async () => {
    const updated = {
      deviceId: "abc-123",
      preferences: { theme: "dark", selectedLocation: "harare", savedLocations: [], selectedActivities: [], hasOnboarded: false },
      createdAt: "2026-02-22T00:00:00Z",
      updatedAt: "2026-02-22T01:00:00Z",
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(updated),
    });

    await syncPreferences("abc-123", { theme: "dark" });

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/py/devices/abc-123",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ theme: "dark" }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// DeviceSyncError
// ---------------------------------------------------------------------------

describe("DeviceSyncError", () => {
  it("has correct name and status", () => {
    const err = new DeviceSyncError("test", 404);
    expect(err.name).toBe("DeviceSyncError");
    expect(err.status).toBe(404);
    expect(err.message).toBe("test");
  });
});

// ---------------------------------------------------------------------------
// Debounced sync
// ---------------------------------------------------------------------------

describe("queueSync", () => {
  it("does not throw when no device ID is set", () => {
    // Should silently no-op
    expect(() => queueSync({ theme: "dark" })).not.toThrow();
  });

  it("debounces multiple calls", async () => {
    localStorageMock.setItem("mukoko-device-id", "test-123");

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ deviceId: "test-123", preferences: {}, createdAt: "", updatedAt: "" }),
    });

    queueSync({ theme: "dark" });
    queueSync({ selectedLocation: "bulawayo" });

    // Wait for debounce (1500ms + buffer)
    await new Promise((r) => setTimeout(r, 2000));

    // Should have made exactly one API call with merged updates
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({ theme: "dark", selectedLocation: "bulawayo" });
  });
});
