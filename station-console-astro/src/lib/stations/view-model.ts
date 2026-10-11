import { INGEST_PATH } from "../config";
import type { StationSummary, StationType } from "./types";
import type { StoredStation } from "./store";

export interface ConsoleStation {
  stationId: string;
  name: string;
  stationType: StationType;
  /** `owner`: held by the signed-in person; `key`: browser-stored key only. */
  access: "owner" | "key";
  /** The saved key, if this browser has one. */
  key?: string | undefined;
}

/** Server list (owner-based) merged with this browser's saved keys. */
export function mergeStations(server: StationSummary[], local: StoredStation[]): ConsoleStation[] {
  const keys = new Map(local.map((s) => [s.stationId, s.key]));
  const out: ConsoleStation[] = server.map((s) => ({
    stationId: s.stationId,
    name: s.name,
    stationType: s.stationType,
    access: "owner",
    key: keys.get(s.stationId),
  }));
  const owned = new Set(server.map((s) => s.stationId));
  for (const s of local) {
    if (!owned.has(s.stationId))
      out.push({ stationId: s.stationId, name: s.name, stationType: s.stationType, access: "key", key: s.key });
  }
  return out;
}

export interface SetupInstructions {
  host: string;
  path: string;
  wunderground: string;
  ecowitt: string;
}

/** Setup text for station hardware; the host is the one hardware already uses. */
export function setupInstructions(host: string, stationId: string): SetupInstructions {
  return {
    host,
    path: INGEST_PATH,
    wunderground: `Wunderground protocol: server ${host}, path ${INGEST_PATH}, ID = ${stationId}, PASSWORD = your ingest key`,
    ecowitt: `Ecowitt protocol: server ${host}, path ${INGEST_PATH}, PASSKEY = ${stationId}:<your ingest key>`,
  };
}

/** "airTemperatureCelsius" -> "air temperature celsius" */
export function metricLabel(name: string): string {
  return name.replace(/([A-Z])/g, " $1").toLowerCase().trim();
}

export function formatMetrics(metrics: Record<string, number> | null): string {
  if (!metrics) return "";
  return Object.entries(metrics)
    .map(([k, v]) => `${metricLabel(k)}: ${v}`)
    .join(" · ");
}

export function describeLastReading(iso: string | null, locale?: string): string {
  if (!iso) return "No readings yet";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "No readings yet";
  return `Last reading ${d.toLocaleString(locale)}`;
}

export function describeReadingResult(res: { accepted: number; qcStatus: string }): string {
  return res.qcStatus === "validated"
    ? `Saved. ${res.accepted} measurement(s) accepted`
    : "Rejected by quality checks";
}
