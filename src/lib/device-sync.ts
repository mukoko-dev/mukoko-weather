/**
 * Device sync — bridges Zustand localStorage with Python device profile API.
 *
 * Hybrid approach:
 *   - localStorage is the primary read source (instant, no latency)
 *   - MongoDB (via Python API) is the persistence layer (recoverable)
 *   - Changes are synced to server on mutation (debounced)
 *   - On first visit, existing localStorage prefs are migrated to server
 *
 * Online-only for Phase 1 — no offline queue.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEVICE_ID_KEY = "mukoko-device-id";
const PREFS_KEY = "mukoko-weather-prefs";
const API_BASE = "/api/py";
const SYNC_DEBOUNCE_MS = 1500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DevicePreferences {
  theme: string;
  selectedLocation: string;
  savedLocations: string[];
  locationLabels: Record<string, string>;
  selectedActivities: string[];
  hasOnboarded: boolean;
}

export interface DeviceProfile {
  deviceId: string;
  preferences: DevicePreferences;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Device ID management
// ---------------------------------------------------------------------------

/** Generate a UUID v4 using crypto.randomUUID (all modern browsers). */
function generateDeviceId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older environments
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Get the device ID from localStorage, or null if not set. */
export function getDeviceId(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(DEVICE_ID_KEY);
}

/** Store the device ID in localStorage. */
function setDeviceId(id: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(DEVICE_ID_KEY, id);
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new DeviceSyncError(
      body.detail || `API error ${res.status}`,
      res.status,
    );
  }

  return res.json();
}

export class DeviceSyncError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "DeviceSyncError";
  }
}

// ---------------------------------------------------------------------------
// Core sync operations
// ---------------------------------------------------------------------------

/**
 * Create a new device profile on the server.
 * Used during first-visit initialization and migration.
 */
export async function createDeviceProfile(
  deviceId: string,
  preferences: DevicePreferences,
): Promise<DeviceProfile> {
  return apiRequest<DeviceProfile>("/devices", {
    method: "POST",
    body: JSON.stringify({ deviceId, preferences }),
  });
}

/** Fetch an existing device profile from the server. */
export async function fetchDeviceProfile(
  deviceId: string,
): Promise<DeviceProfile | null> {
  try {
    return await apiRequest<DeviceProfile>(`/devices/${deviceId}`);
  } catch (err) {
    if (err instanceof DeviceSyncError && err.status === 404) {
      return null;
    }
    throw err;
  }
}

/** Partially update preferences on the server. */
export async function syncPreferences(
  deviceId: string,
  updates: Partial<DevicePreferences>,
): Promise<DeviceProfile> {
  return apiRequest<DeviceProfile>(`/devices/${deviceId}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

// ---------------------------------------------------------------------------
// Debounced sync
// ---------------------------------------------------------------------------

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let pendingUpdates: Partial<DevicePreferences> = {};

/**
 * Queue a preference update for debounced sync to server.
 * Merges with any pending updates. Fires after SYNC_DEBOUNCE_MS of inactivity.
 */
export function queueSync(updates: Partial<DevicePreferences>): void {
  const deviceId = getDeviceId();
  if (!deviceId) return;

  // Merge with pending updates
  pendingUpdates = { ...pendingUpdates, ...updates };

  // Reset debounce timer
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    const toSync = { ...pendingUpdates };
    pendingUpdates = {};
    syncTimer = null;

    // Fire-and-forget — don't block UI on network
    syncPreferences(deviceId, toSync).catch(() => {
      // Network error — preferences are safe in localStorage.
      // Will sync on next mutation or page load.
    });
  }, SYNC_DEBOUNCE_MS);
}

/** Flush any pending sync immediately. Useful before page unload. */
export function flushSync(): void {
  const deviceId = getDeviceId();
  if (!deviceId || Object.keys(pendingUpdates).length === 0) return;

  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }

  const toSync = { ...pendingUpdates };
  pendingUpdates = {};

  // Use sendBeacon for reliability during page unload
  if (typeof navigator !== "undefined" && navigator.sendBeacon) {
    navigator.sendBeacon(
      `${API_BASE}/devices/${deviceId}`,
      new Blob([JSON.stringify(toSync)], { type: "application/json" }),
    );
  }
}

// ---------------------------------------------------------------------------
// Migration — localStorage → server profile
// ---------------------------------------------------------------------------

/**
 * Read existing preferences from the Zustand localStorage key.
 * Returns null if no stored preferences exist.
 */
export function readLocalStoragePrefs(): DevicePreferences | null {
  if (typeof localStorage === "undefined") return null;

  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    const state = parsed?.state;
    if (!state) return null;

    return {
      theme: state.theme ?? "system",
      selectedLocation: state.selectedLocation ?? "harare",
      savedLocations: state.savedLocations ?? [],
      locationLabels: state.locationLabels ?? {},
      selectedActivities: state.selectedActivities ?? [],
      hasOnboarded: state.hasOnboarded ?? false,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Initialization — called once on app load
// ---------------------------------------------------------------------------

let initPromise: Promise<void> | null = null;

/**
 * Initialize device sync. Called once on app startup.
 *
 * Flow:
 * 1. If no device ID → first visit:
 *    a. Generate UUID, store in localStorage
 *    b. Read any existing Zustand prefs (migration)
 *    c. POST /api/py/devices to create server profile
 * 2. If device ID exists → returning visit:
 *    a. Background fetch server profile
 *    b. If server has data and local is default → restore from server
 *
 * @param getCurrentPrefs - Callback to read current Zustand state
 * @param applyPrefs - Callback to apply server preferences to Zustand
 */
export function initDeviceSync(
  getCurrentPrefs: () => DevicePreferences,
  applyPrefs: (prefs: DevicePreferences) => void,
): void {
  // Only run once
  if (initPromise) return;

  initPromise = (async () => {
    try {
      let deviceId = getDeviceId();

      if (!deviceId) {
        // First visit — generate ID and create server profile
        deviceId = generateDeviceId();
        setDeviceId(deviceId);

        // Migration: read any existing localStorage prefs
        const existingPrefs = readLocalStoragePrefs();
        const prefs = existingPrefs ?? getCurrentPrefs();

        await createDeviceProfile(deviceId, prefs);
      } else {
        // Returning visit — check server for recovery scenario
        const serverProfile = await fetchDeviceProfile(deviceId);

        if (serverProfile) {
          const localPrefs = getCurrentPrefs();
          const serverPrefs = serverProfile.preferences;

          // If local state looks like defaults but server has real data,
          // restore from server (user cleared localStorage or new browser)
          const isLocalDefault =
            localPrefs.selectedLocation === "harare" &&
            localPrefs.savedLocations.length === 0 &&
            localPrefs.selectedActivities.length === 0 &&
            !localPrefs.hasOnboarded;

          const serverHasData =
            serverPrefs.selectedLocation !== "harare" ||
            serverPrefs.savedLocations.length > 0 ||
            serverPrefs.selectedActivities.length > 0 ||
            serverPrefs.hasOnboarded;

          if (isLocalDefault && serverHasData) {
            applyPrefs(serverPrefs);
          }
        } else {
          // Device ID exists locally but not on server (server data lost).
          // Re-create the profile with current local preferences.
          const prefs = getCurrentPrefs();
          await createDeviceProfile(deviceId, prefs).catch(() => {
            // Server unavailable — will retry on next page load
          });
        }
      }
    } catch {
      // Network error during init — not critical.
      // localStorage still works, sync will retry on next mutation.
    }
  })();
}

/** Reset init state (for testing). */
export function _resetDeviceSync(): void {
  initPromise = null;
  pendingUpdates = {};
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
}
