/**
 * Safe wrappers around the Web Storage API.
 *
 * Every accessor is SSR-safe (returns the fallback when `window` is missing)
 * and never throws: storage can be blocked by browser settings, unavailable
 * in private mode, or full (quota). Callers get `null` / `false` / the
 * supplied fallback instead and render the same as "nothing stored".
 *
 * Use these instead of touching `localStorage` / `sessionStorage` directly.
 * Storage is per-viewer and best-effort — never store state that must survive
 * reliably here (use RxDB / the Python API for that).
 */

export type StorageKind = "local" | "session";

/** Resolve the requested Storage, or null when unavailable (SSR, blocked, etc.). */
function getStorage(kind: StorageKind = "local"): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    const store =
      kind === "session" ? globalThis.sessionStorage : globalThis.localStorage;
    return store ?? null;
  } catch {
    return null;
  }
}

/** Read a raw string value. Returns null when absent or unavailable. */
export function readStorage(
  key: string,
  storage: StorageKind = "local",
): string | null {
  const store = getStorage(storage);
  if (!store) return null;
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

/** Write a raw string value. Returns false when the write failed (quota, blocked). */
export function writeStorage(
  key: string,
  value: string,
  storage: StorageKind = "local",
): boolean {
  const store = getStorage(storage);
  if (!store) return false;
  try {
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Remove a key. Never throws. */
export function removeStorage(
  key: string,
  storage: StorageKind = "local",
): void {
  const store = getStorage(storage);
  if (!store) return;
  try {
    store.removeItem(key);
  } catch {
    // Storage blocked or unavailable — nothing to remove.
  }
}

/** All keys currently stored. Returns [] when unavailable. */
export function listStorageKeys(storage: StorageKind = "local"): string[] {
  const store = getStorage(storage);
  if (!store) return [];
  const keys: string[] = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k) keys.push(k);
    }
  } catch {
    // Storage blocked mid-iteration — return whatever was collected.
  }
  return keys;
}

/**
 * Parse a raw stored string as JSON. Returns `fallback` for null input or
 * malformed JSON.
 */
export function parseStoredJSON<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Read and JSON-parse a value. Returns `fallback` when absent, unavailable or malformed. */
export function readStorageJSON<T>(
  key: string,
  fallback: T,
  storage: StorageKind = "local",
): T {
  return parseStoredJSON(readStorage(key, storage), fallback);
}

/** JSON-serialise and write a value. Returns false on failure (quota, blocked, unserialisable). */
export function writeStorageJSON(
  key: string,
  value: unknown,
  storage: StorageKind = "local",
): boolean {
  try {
    return writeStorage(key, JSON.stringify(value), storage);
  } catch {
    return false;
  }
}
