import type { StationType } from "./types";

/**
 * Station credentials live in the OWNER's browser only. Same key and shape
 * as the Next.js console, so existing users keep their saved stations.
 */
export const STORE_KEY = "mws-console-stations";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export interface StoredStation {
  stationId: string;
  key: string;
  name: string;
  stationType: StationType;
}

function isStored(v: unknown): v is StoredStation {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.stationId === "string" &&
    typeof s.key === "string" &&
    typeof s.name === "string" &&
    (s.stationType === "digital" || s.stationType === "manual")
  );
}

export function loadStations(storage: StorageLike | null): StoredStation[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStored);
  } catch {
    return [];
  }
}

export function saveStations(
  storage: StorageLike | null,
  stations: StoredStation[],
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(STORE_KEY, JSON.stringify(stations));
    return true;
  } catch {
    return false;
  }
}

export function addStation(
  list: StoredStation[],
  entry: StoredStation,
): StoredStation[] {
  return [...list.filter((s) => s.stationId !== entry.stationId), entry];
}

export function removeStation(
  list: StoredStation[],
  stationId: string,
): StoredStation[] {
  return list.filter((s) => s.stationId !== stationId);
}

export function replaceKey(
  list: StoredStation[],
  stationId: string,
  key: string,
): StoredStation[] {
  return list.map((s) => (s.stationId === stationId ? { ...s, key } : s));
}
