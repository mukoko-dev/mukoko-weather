/**
 * Tell the account about this device (signed in only), without ever making
 * it a requirement.
 *
 * The device record is created by the server from the signed-in person's
 * session; the browser only reports its own coarse facts. When the platform
 * cannot take them yet (503), when the person is signed out (401) or when the
 * network is down, the device simply stays local: the RxDB preferences and
 * the device-state mirror are the source of truth on the device either way.
 *
 * Pure with injected dependencies, so the whole state machine is tested in
 * node. `use-device-heartbeat.ts` supplies the browser ones.
 */

import type { DeviceState } from "./device-state";
import {
  deviceLabel,
  parseUserAgent,
  webPlatform,
  type DeviceFormFactor,
  type WebPlatform,
} from "./device-info";

export const DEVICE_SYNC_AT_KEY = "mukoko-device-synced-at";
/** One report per device per hour; a heartbeat, not a stream. */
export const DEVICE_SYNC_INTERVAL_MS = 60 * 60 * 1000;

export type DeviceSyncResult =
  /** The platform has this device's latest facts. */
  | "synced"
  /** Signed out, platform not ready, or offline: kept on this device. */
  | "local-only"
  /** Reported within the last hour. */
  | "skipped";

export interface DevicePreferencesSnapshot {
  theme: string;
  selectedActivities: string[];
  savedLocations: string[];
  selectedForecastModel: string;
  homeLocation: string | null;
}

export interface DeviceSyncDeps {
  now: () => number;
  deviceId: () => string;
  userAgent: string;
  standalone: boolean;
  state: () => DeviceState;
  preferences: () => DevicePreferencesSnapshot;
  readSyncedAt: () => number | null;
  writeSyncedAt: (at: number) => void;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}

export interface DeviceReport {
  deviceId: string;
  name: string;
  platform: WebPlatform;
  formFactor: DeviceFormFactor;
  standalone: boolean;
  permissions: {
    geolocation: DeviceState["geolocation"];
    notifications: DeviceState["notifications"];
  };
  preferences: {
    theme: string;
    selectedActivities: string[];
    savedLocations: string[];
    forecastModel: string;
    homeLocation: string | null;
  };
}

/** What this device reports. No position, no user agent string, no IP. */
export function buildDeviceReport(deps: DeviceSyncDeps): DeviceReport {
  const parsed = parseUserAgent(deps.userAgent);
  const state = deps.state();
  const prefs = deps.preferences();
  return {
    deviceId: deps.deviceId(),
    name: deviceLabel(parsed),
    platform: webPlatform(parsed),
    formFactor: parsed.formFactor,
    standalone: deps.standalone,
    permissions: {
      geolocation: state.geolocation,
      notifications: state.notifications,
    },
    preferences: {
      theme: prefs.theme,
      selectedActivities: prefs.selectedActivities,
      savedLocations: prefs.savedLocations,
      forecastModel: prefs.selectedForecastModel,
      homeLocation: prefs.homeLocation,
    },
  };
}

export async function syncDevice(
  deps: DeviceSyncDeps,
  options: { force?: boolean } = {},
): Promise<DeviceSyncResult> {
  const now = deps.now();
  const last = deps.readSyncedAt();
  if (
    !options.force &&
    last !== null &&
    now >= last &&
    now - last < DEVICE_SYNC_INTERVAL_MS
  ) {
    return "skipped";
  }
  try {
    const response = await deps.fetch("/api/devices", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildDeviceReport(deps)),
    });
    // Any answer, including "not available yet", counts as the hourly try.
    deps.writeSyncedAt(now);
    return response.ok ? "synced" : "local-only";
  } catch {
    return "local-only";
  }
}
