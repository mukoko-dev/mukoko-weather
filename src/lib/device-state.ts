/**
 * What this device has decided, kept on the device (the local mirror).
 *
 * Per device, never per person: browser permissions belong to the browser
 * profile. When the person is signed in the same facts are also sent to the
 * platform device record (`device-sync.ts`); signed out, this mirror is the
 * only copy, and everything still works.
 *
 * Coarse by design: a permission state and when it last changed. No position,
 * no address, no user agent.
 */

import {
  readStorageJSON,
  removeStorage,
  writeStorageJSON,
} from "./safe-storage";

export const DEVICE_STATE_KEY = "mukoko-device-state";
/** The old, permanent "dismissed the location card" flag. */
export const LEGACY_LOCATION_CARD_DISMISSED_KEY =
  "mukoko-location-card-dismissed";
/** A "Not now" is not a "No": the ask may come back once after this long. */
export const DISMISS_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

export type PermissionKind = "geolocation" | "notifications";

/**
 * `dismissed` is "Not now" on our own card (the browser was never asked).
 * `denied` is the browser's answer, or what it reports.
 */
export type StoredPermissionState =
  | "granted"
  | "denied"
  | "prompt"
  | "dismissed"
  | "unsupported";

export interface StoredPermission {
  state: StoredPermissionState;
  changedAt: number;
}

export interface DeviceState {
  v: 1;
  geolocation: StoredPermission | null;
  notifications: StoredPermission | null;
}

const STATES: ReadonlySet<string> = new Set([
  "granted",
  "denied",
  "prompt",
  "dismissed",
  "unsupported",
]);

const EMPTY: DeviceState = { v: 1, geolocation: null, notifications: null };

function cleanPermission(value: unknown): StoredPermission | null {
  if (!value || typeof value !== "object") return null;
  const { state, changedAt } = value as Record<string, unknown>;
  if (typeof state !== "string" || !STATES.has(state)) return null;
  if (typeof changedAt !== "number" || !Number.isFinite(changedAt)) return null;
  return { state: state as StoredPermissionState, changedAt };
}

/** The stored state; anything malformed reads as nothing decided. */
export function readDeviceState(): DeviceState {
  const raw = readStorageJSON<Record<string, unknown> | null>(
    DEVICE_STATE_KEY,
    null,
  );
  if (!raw || typeof raw !== "object" || raw.v !== 1) return { ...EMPTY };
  return {
    v: 1,
    geolocation: cleanPermission(raw.geolocation),
    notifications: cleanPermission(raw.notifications),
  };
}

/**
 * Record a permission outcome. `changedAt` moves only when the state does, so
 * "last changed" stays true across repeated checks on every launch.
 */
export function recordPermission(
  kind: PermissionKind,
  state: StoredPermissionState,
  now: number = Date.now(),
): DeviceState {
  const current = readDeviceState();
  if (current[kind]?.state === state) return current;
  const next: DeviceState = { ...current, [kind]: { state, changedAt: now } };
  writeStorageJSON(DEVICE_STATE_KEY, next);
  return next;
}

/** Forget everything decided on this device (sign-out of the whole app). */
export function clearDeviceState(): void {
  removeStorage(DEVICE_STATE_KEY);
}

export type BrowserPermission = PermissionState | "unknown";

export type LocationAsk =
  /** Already allowed: refresh quietly, no card. */
  | "refresh-silently"
  /** Show the one calm pre-prompt; the browser prompt waits for the tap. */
  | "show-prompt"
  /** Blocked: never ask again from inside the app. */
  | "hide-denied"
  /** "Not now" was said recently. */
  | "hide-dismissed";

/**
 * Whether to ask for location on this launch.
 *
 * The browser's own answer wins when it gives one. When it cannot (older
 * Safari, some installed apps) we go by what we stored, and never call the
 * geolocation API without a tap: on iOS that would raise a prompt with no
 * gesture behind it.
 */
export function decideLocationAsk(input: {
  browser: BrowserPermission;
  stored: StoredPermission | null;
  now?: number;
}): LocationAsk {
  const { browser, stored } = input;
  const now = input.now ?? Date.now();
  if (browser === "granted") return "refresh-silently";
  if (browser === "denied") return "hide-denied";
  if (browser === "unknown" && stored?.state === "denied") return "hide-denied";
  if (
    stored?.state === "dismissed" &&
    now - stored.changedAt < DISMISS_RETRY_MS
  ) {
    return "hide-dismissed";
  }
  return "show-prompt";
}

/** The browser's answer, or "unknown" when it will not say. */
export async function readBrowserPermission(
  name: "geolocation" | "notifications" = "geolocation",
): Promise<BrowserPermission> {
  try {
    const status = await navigator.permissions?.query({
      name: name as PermissionName,
    });
    return status ? status.state : "unknown";
  } catch {
    return "unknown";
  }
}
