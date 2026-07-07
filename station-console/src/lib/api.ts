/**
 * Typed client for the station endpoints served by the mukoko-weather
 * Python backend (the stable ingest/API layer — see api/py/_stations.py in
 * this monorepo). The console is UI only; all writes go through that API.
 */

export const API_BASE =
  process.env.NEXT_PUBLIC_WEATHER_API_BASE ?? "https://weather.mukoko.com";

export interface RegisteredStation {
  stationId: string;
  key: string;
  name: string;
  stationType: "digital" | "manual";
}

export interface StationStatus {
  stationId: string;
  name: string;
  stationType: string;
  status: string;
  lastObservationAt: string | null;
  latestMetrics: Record<string, number> | null;
}

const STORE_KEY = "mws-console-stations";

/** Local registry — station credentials live in the OWNER's browser only. */
export function loadStations(): RegisteredStation[] {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveStations(stations: RegisteredStation[]): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(stations));
}

export async function registerStation(body: {
  name: string;
  lat: number;
  lon: number;
  stationType: "digital" | "manual";
  hardware?: string;
  country?: string;
}) {
  const res = await fetch(`${API_BASE}/api/py/stations/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(
      (await res.json().catch(() => null))?.detail ??
        `Registration failed (${res.status})`,
    );
  return res.json();
}

export async function fetchStatus(
  station: RegisteredStation,
): Promise<StationStatus> {
  const res = await fetch(
    `${API_BASE}/api/py/stations/status?id=${encodeURIComponent(station.stationId)}&key=${encodeURIComponent(station.key)}`,
  );
  if (!res.ok) throw new Error(`Status failed (${res.status})`);
  return res.json();
}

export async function submitManualReading(
  station: RegisteredStation,
  reading: Record<string, number | string | undefined>,
) {
  const res = await fetch(`${API_BASE}/api/py/stations/manual`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stationId: station.stationId,
      key: station.key,
      ...reading,
    }),
  });
  if (!res.ok)
    throw new Error(
      (await res.json().catch(() => null))?.detail ??
        `Submit failed (${res.status})`,
    );
  return res.json();
}
