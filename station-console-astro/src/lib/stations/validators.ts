import {
  READING_FIELDS,
  type ReadingInput,
  type RegisterInput,
  type StationType,
} from "./types";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Mirrors the backend ids (`mws-` + 8 hex) so a bad id never leaves the BFF. */
export const STATION_ID_RE = /^mws-[a-f0-9]{8}$/;

/** Same limits as the backend's ManualReadingRequest. */
export const READING_LIMITS: Record<(typeof READING_FIELDS)[number], readonly [number, number]> = {
  temperatureC: [-50, 60],
  rainfallMm: [0, 500],
  humidityPercent: [0, 100],
  pressureHpa: [800, 1100],
  windKph: [0, 250],
};

export function isStationId(value: unknown): value is string {
  return typeof value === "string" && STATION_ID_RE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function parseRegisterInput(raw: unknown): Parsed<RegisterInput> {
  if (!isRecord(raw)) return { ok: false, error: "Send the station details as JSON." };

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name.length < 2 || name.length > 80)
    return { ok: false, error: "Station name must be 2 to 80 characters." };

  const lat = num(raw.lat);
  if (lat === null || lat < -90 || lat > 90)
    return { ok: false, error: "Latitude must be a number between -90 and 90." };
  const lon = num(raw.lon);
  if (lon === null || lon < -180 || lon > 180)
    return { ok: false, error: "Longitude must be a number between -180 and 180." };

  const stationType: StationType | null =
    raw.stationType === "digital" || raw.stationType === "manual" ? raw.stationType : null;
  if (!stationType) return { ok: false, error: "Station type must be digital or manual." };

  const value: RegisterInput = { name, lat, lon, stationType };
  if (raw.hardware !== undefined && raw.hardware !== null && raw.hardware !== "") {
    const hardware = typeof raw.hardware === "string" ? raw.hardware.trim() : "";
    if (hardware.length > 80) return { ok: false, error: "Hardware must be at most 80 characters." };
    if (hardware) value.hardware = hardware;
  }
  return { ok: true, value };
}

export function parseReadingInput(raw: unknown): Parsed<ReadingInput> {
  if (!isRecord(raw)) return { ok: false, error: "Send the reading as JSON." };
  const value: ReadingInput = {};
  for (const field of READING_FIELDS) {
    const given = raw[field];
    if (given === undefined || given === null || given === "") continue;
    const n = num(given);
    const [lo, hi] = READING_LIMITS[field];
    if (n === null || n < lo || n > hi)
      return { ok: false, error: `${field} must be a number between ${lo} and ${hi}.` };
    value[field] = n;
  }
  if (Object.keys(value).length === 0)
    return { ok: false, error: "At least one measurement is required." };
  return { ok: true, value };
}
