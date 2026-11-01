/**
 * Typed client for the station endpoints served by the mukoko-weather
 * stations Worker (`workers/stations` in this monorepo, Rust on Cloudflare;
 * the Python backend it replaced is gone). The console is UI only; all writes
 * go through that API.
 *
 * The Worker serves every route both as `/stations/*` and as
 * `/api/py/stations/*`, the prefix the Python used; this client keeps the
 * prefixed form it has always called.
 *
 * TRANSITIONAL: the console calls the stations Worker's own host directly.
 * Weather is to be served behind the gateway (one way in), which forwards the
 * station routes to the Worker with the protocol unchanged; then `API_BASE`
 * becomes the gateway's origin. Nothing on `weather.mukoko.com` serves these
 * routes any more (the Python behind it is deleted), so a project that still
 * sets `NEXT_PUBLIC_WEATHER_API_BASE` to `https://weather.mukoko.com` must
 * unset it.
 */

export const API_BASE =
  process.env.NEXT_PUBLIC_WEATHER_API_BASE ??
  "https://weather-ingest.nyuchi.com";

/** The words to show for a refused request: the Worker's `error_description`, else a legacy `detail`. */
async function refusal(res: Response, fallback: string): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  if (typeof body === "object" && body !== null) {
    const b = body as { error_description?: unknown; detail?: unknown };
    for (const text of [b.error_description, b.detail]) {
      if (typeof text === "string" && text.trim()) return text;
    }
  }
  return `${fallback} (${res.status})`;
}

/** How to point a console at the ingest endpoint, as the Worker states it at registration. */
export interface IngestInstructions {
  wunderground: { server: string; path: string; params: string };
  ecowitt: { server: string; path: string; note: string };
}

export interface RegistrationResult {
  stationId: string;
  ingestKey: string;
  stationType: "digital" | "manual";
  ingest: IngestInstructions;
}

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
}): Promise<RegistrationResult> {
  const res = await fetch(`${API_BASE}/api/py/stations/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await refusal(res, "Registration failed"));
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
  if (!res.ok) throw new Error(await refusal(res, "Submit failed"));
  return res.json();
}
