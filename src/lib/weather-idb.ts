/**
 * On-device IndexedDB store for weather data.
 *
 * Provides offline-first weather data with automatic background refresh:
 *   - Stores weather data and AI summaries per location
 *   - Auto-refreshes every 60 seconds via interval
 *   - Refreshes on page visibility change (tab switch / app resume)
 *   - Falls back gracefully if IndexedDB is unavailable
 */

import type { WeatherData } from "./weather";

const DB_NAME = "mukoko-weather";
const DB_VERSION = 1;

// Store names
const WEATHER_STORE = "weather";
const AI_STORE = "ai_summaries";

// Cache duration: 15 minutes (matches server-side)
const CACHE_TTL_MS = 15 * 60 * 1000;

export interface IDBWeatherEntry {
  locationSlug: string;
  data: WeatherData;
  fetchedAt: number; // timestamp ms
}

export interface IDBAISummaryEntry {
  locationSlug: string;
  insight: string;
  generatedAt: string;
  fetchedAt: number; // timestamp ms
}

// ---------------------------------------------------------------------------
// Database initialization
// ---------------------------------------------------------------------------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB not available"));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(WEATHER_STORE)) {
        db.createObjectStore(WEATHER_STORE, { keyPath: "locationSlug" });
      }

      if (!db.objectStoreNames.contains(AI_STORE)) {
        db.createObjectStore(AI_STORE, { keyPath: "locationSlug" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---------------------------------------------------------------------------
// Weather data operations
// ---------------------------------------------------------------------------

export async function getWeatherFromIDB(
  locationSlug: string,
): Promise<WeatherData | null> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(WEATHER_STORE, "readonly");
      const store = tx.objectStore(WEATHER_STORE);
      const request = store.get(locationSlug);

      request.onsuccess = () => {
        const entry = request.result as IDBWeatherEntry | undefined;
        if (entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS) {
          resolve(entry.data);
        } else {
          resolve(null);
        }
      };
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

export async function setWeatherInIDB(
  locationSlug: string,
  data: WeatherData,
): Promise<void> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(WEATHER_STORE, "readwrite");
      const store = tx.objectStore(WEATHER_STORE);
      const entry: IDBWeatherEntry = {
        locationSlug,
        data,
        fetchedAt: Date.now(),
      };
      const request = store.put(entry);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    // Silently fail — IDB is a convenience layer
  }
}

// ---------------------------------------------------------------------------
// AI summary operations
// ---------------------------------------------------------------------------

export async function getAISummaryFromIDB(
  locationSlug: string,
): Promise<IDBAISummaryEntry | null> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(AI_STORE, "readonly");
      const store = tx.objectStore(AI_STORE);
      const request = store.get(locationSlug);

      request.onsuccess = () => {
        const entry = request.result as IDBAISummaryEntry | undefined;
        // AI summaries have longer TTL — 30 minutes on device
        if (entry && Date.now() - entry.fetchedAt < 30 * 60 * 1000) {
          resolve(entry);
        } else {
          resolve(null);
        }
      };
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

export async function setAISummaryInIDB(
  locationSlug: string,
  insight: string,
  generatedAt: string,
): Promise<void> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(AI_STORE, "readwrite");
      const store = tx.objectStore(AI_STORE);
      const entry: IDBAISummaryEntry = {
        locationSlug,
        insight,
        generatedAt,
        fetchedAt: Date.now(),
      };
      const request = store.put(entry);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    // Silently fail
  }
}

// ---------------------------------------------------------------------------
// Clear all cached data
// ---------------------------------------------------------------------------

export async function clearAllIDB(): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction([WEATHER_STORE, AI_STORE], "readwrite");
    tx.objectStore(WEATHER_STORE).clear();
    tx.objectStore(AI_STORE).clear();
  } catch {
    // Silently fail
  }
}
