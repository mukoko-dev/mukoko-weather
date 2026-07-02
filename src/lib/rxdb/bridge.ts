/**
 * RxDB ↔ Zustand bridge.
 *
 * Responsibilities:
 *   1. On startup: hydrate Zustand from RxDB preferences document
 *   2. Subscribe to RxDB changes → push to Zustand (multi-tab sync)
 *   3. Provide write functions that update RxDB (which triggers replication)
 *   4. One-time migration from old localStorage format to RxDB
 *
 * Zustand keeps transient UI state (modals, shamwariContext).
 * RxDB owns persistent state (theme, locations, activities, onboarding).
 */

import { preferencesCollection } from "./collections";
import type { PreferencesDocType } from "./schemas";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEGACY_PREFS_KEY = "mukoko-weather-prefs";
const LEGACY_DEVICE_ID_KEY = "mukoko-device-id";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BridgeCallbacks {
  /** Apply RxDB preferences to Zustand (called on hydration + external changes). */
  applyToStore: (prefs: Partial<PreferencesDocType>) => void;
  /** Read current Zustand preferences (for initial RxDB seed). */
  getCurrentPrefs: () => Omit<PreferencesDocType, "id" | "updatedAt">;
}

// ---------------------------------------------------------------------------
// Device ID
// ---------------------------------------------------------------------------

/** Generate a UUID v4. */
function generateDeviceId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

let _deviceId: string | null = null;

/**
 * Get or create the device ID. Stored in localStorage for cross-session persistence,
 * since IndexedDB may be cleared independently.
 */
export function getDeviceId(): string {
  if (_deviceId) return _deviceId;

  if (typeof localStorage !== "undefined") {
    const stored = localStorage.getItem(LEGACY_DEVICE_ID_KEY);
    if (stored) {
      _deviceId = stored;
      return stored;
    }
  }

  const id = generateDeviceId();
  _deviceId = id;

  if (typeof localStorage !== "undefined") {
    localStorage.setItem(LEGACY_DEVICE_ID_KEY, id);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Migration — one-time localStorage → RxDB
// ---------------------------------------------------------------------------

interface LegacyState {
  theme?: string;
  selectedLocation?: string;
  savedLocations?: string[];
  locationLabels?: Record<string, string>;
  selectedActivities?: string[];
  hasOnboarded?: boolean;
  selectedForecastModel?: string;
}

/**
 * Read legacy Zustand persist state from localStorage.
 * Returns null if no legacy data exists.
 */
function readLegacyPrefs(): LegacyState | null {
  if (typeof localStorage === "undefined") return null;

  try {
    const raw = localStorage.getItem(LEGACY_PREFS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.state ?? null;
  } catch {
    return null;
  }
}

/**
 * Persist preferences to the legacy localStorage key.
 *
 * Used as the fallback persistence layer when RxDB is unavailable (private
 * browsing, DB9, quota, etc.) so `selectedForecastModel` and every other
 * preference still survive reloads via Zustand + localStorage. When RxDB is
 * healthy this is never called (RxDB owns persistence and clears this key
 * during migration), so the two paths never fight.
 */
function writeLegacyPrefs(updates: Partial<Omit<PreferencesDocType, "id">>): void {
  if (typeof localStorage === "undefined") return;
  try {
    const raw = localStorage.getItem(LEGACY_PREFS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const state = { ...(parsed?.state ?? {}), ...updates };
    localStorage.setItem(LEGACY_PREFS_KEY, JSON.stringify({ ...parsed, state }));
  } catch {
    // localStorage unavailable/full — nothing more we can do.
  }
}

/** Hydrate Zustand from legacy localStorage (RxDB-unavailable fallback path). */
function hydrateFromLegacy(callbacks: BridgeCallbacks): void {
  const legacy = readLegacyPrefs();
  if (!legacy) return;
  try {
    callbacks.applyToStore(legacy as Partial<PreferencesDocType>);
  } catch {
    // applyToStore should never throw, but guard anyway.
  }
}

/**
 * Migrate legacy localStorage preferences to RxDB.
 * Safe to call multiple times — no-ops if RxDB already has data.
 */
export async function migrateLocalStorageToRxDB(): Promise<void> {
  try {
    await _doMigrate();
  } catch {
    // Migration is best-effort — legacy localStorage stays intact on failure.
  }
}

async function _doMigrate(): Promise<void> {
  const col = await preferencesCollection();
  if (!col) return;

  const deviceId = getDeviceId();
  const existing = await col.findOne(deviceId).exec();

  // Already migrated — skip
  if (existing) return;

  const legacy = readLegacyPrefs();
  if (!legacy) return;

  await col.upsert({
    id: deviceId,
    theme: legacy.theme ?? "system",
    selectedLocation: legacy.selectedLocation ?? "",
    savedLocations: legacy.savedLocations ?? [],
    locationLabels: legacy.locationLabels ?? {},
    selectedActivities: legacy.selectedActivities ?? [],
    hasOnboarded: legacy.hasOnboarded ?? false,
    selectedForecastModel: legacy.selectedForecastModel ?? "best_match",
    updatedAt: Date.now(),
  });

  // Clean up legacy keys after successful migration
  try {
    localStorage.removeItem(LEGACY_PREFS_KEY);
    // Remove legacy weather hint keys
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith("mukoko-weather-hint:")) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }
  } catch {
    // localStorage cleanup is best-effort
  }
}

// ---------------------------------------------------------------------------
// Bridge initialization
// ---------------------------------------------------------------------------

let _initPromise: Promise<void> | null = null;
let _subscription: { unsubscribe: () => void } | null = null;

/**
 * Initialize the RxDB ↔ Zustand bridge.
 *
 * Uses a promise guard instead of a boolean flag so that:
 *   - concurrent calls await the same initialization
 *   - if preferencesCollection() returns null (e.g. private browsing),
 *     subsequent calls can retry rather than being permanently no-ops
 */
export function initRxDBBridge(callbacks: BridgeCallbacks): Promise<void> {
  if (_initPromise) return _initPromise;
  if (typeof window === "undefined") return Promise.resolve();

  _initPromise = _doInitBridge(callbacks);
  return _initPromise;
}

async function _doInitBridge(callbacks: BridgeCallbacks): Promise<void> {
  try {
    const col = await preferencesCollection();
    if (!col) {
      // RxDB unavailable — hydrate from legacy localStorage so preferences
      // (theme, selectedForecastModel, …) still work this session, and allow
      // a retry on the next call (IndexedDB may become available later).
      hydrateFromLegacy(callbacks);
      _initPromise = null;
      return;
    }

    // Step 1: Migrate legacy data
    await migrateLocalStorageToRxDB();

    const deviceId = getDeviceId();

    // Step 2: Ensure preferences doc exists
    let doc = await col.findOne(deviceId).exec();
    if (!doc) {
      const currentPrefs = callbacks.getCurrentPrefs();
      await col.upsert({
        id: deviceId,
        ...currentPrefs,
        updatedAt: Date.now(),
      });
      doc = await col.findOne(deviceId).exec();
    }

    // Step 3: Hydrate Zustand from RxDB
    if (doc) {
      callbacks.applyToStore({
        theme: doc.theme,
        selectedLocation: doc.selectedLocation,
        savedLocations: doc.savedLocations,
        locationLabels: doc.locationLabels as Record<string, string>,
        selectedActivities: doc.selectedActivities,
        hasOnboarded: doc.hasOnboarded,
        selectedForecastModel: doc.selectedForecastModel,
      });
    }

    // Step 4: Subscribe to RxDB changes (multi-tab sync via leader election)
    const query = col.findOne(deviceId);
    _subscription = query.$.subscribe((rxDoc) => {
      if (!rxDoc) return;
      try {
        callbacks.applyToStore({
          theme: rxDoc.theme,
          selectedLocation: rxDoc.selectedLocation,
          savedLocations: rxDoc.savedLocations,
          locationLabels: rxDoc.locationLabels as Record<string, string>,
          selectedActivities: rxDoc.selectedActivities,
          hasOnboarded: rxDoc.hasOnboarded,
          selectedForecastModel: rxDoc.selectedForecastModel,
        });
      } catch {
        // never let a subscription callback bubble into RxDB internals
      }
    });
  } catch (err) {
    // Any RxDB failure (DB9, schema conflict, storage error) must never crash
    // the app — fall back to localStorage-hydrated Zustand and allow retry.
    console.warn("[RxDB] bridge init failed — using localStorage fallback:", String(err));
    hydrateFromLegacy(callbacks);
    _initPromise = null;
  }
}

// ---------------------------------------------------------------------------
// Write helpers — called by Zustand setters to persist to RxDB
// ---------------------------------------------------------------------------

/**
 * Update preferences in RxDB. Triggers replication automatically.
 */
export async function updatePreferences(
  updates: Partial<Omit<PreferencesDocType, "id">>,
): Promise<void> {
  try {
    const col = await preferencesCollection();
    if (!col) {
      // RxDB unavailable — persist to localStorage so the preference survives.
      writeLegacyPrefs(updates);
      return;
    }

    const deviceId = getDeviceId();
    const doc = await col.findOne(deviceId).exec();

    if (doc) {
      await doc.patch({ ...updates, updatedAt: Date.now() });
    } else {
      // Shouldn't happen after init, but handle gracefully
      await col.upsert({
        id: deviceId,
        theme: "system",
        selectedLocation: "",
        savedLocations: [],
        locationLabels: {},
        selectedActivities: [],
        hasOnboarded: false,
        selectedForecastModel: "best_match",
        ...updates,
        updatedAt: Date.now(),
      });
    }
  } catch {
    // RxDB write failed — fall back to localStorage, never throw to the caller.
    writeLegacyPrefs(updates);
  }
}

// ---------------------------------------------------------------------------
// Cleanup (for testing)
// ---------------------------------------------------------------------------

export function _resetBridge(): void {
  _initPromise = null;
  if (_subscription) {
    _subscription.unsubscribe();
    _subscription = null;
  }
  _deviceId = null;
}
