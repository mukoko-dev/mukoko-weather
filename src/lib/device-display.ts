/**
 * Words for the Devices section of /profile. Pure, so the copy and the
 * relative times are tested without a DOM.
 */

import type {
  PermissionKind,
  StoredPermission,
  StoredPermissionState,
} from "./device-state";
import type { DevicePreferencesSnapshot } from "./device-sync";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "Active now", "3 hours ago", "2 days ago", or the date for older. */
export function lastActiveLabel(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "Active recently";
  const age = Math.max(0, now - t);
  if (age < 5 * MINUTE) return "Active now";
  if (age < HOUR) return `Active ${Math.floor(age / MINUTE)} minutes ago`;
  if (age < DAY) {
    const h = Math.floor(age / HOUR);
    return `Active ${h} ${h === 1 ? "hour" : "hours"} ago`;
  }
  if (age < 30 * DAY) {
    const d = Math.floor(age / DAY);
    return `Active ${d} ${d === 1 ? "day" : "days"} ago`;
  }
  return `Active ${new Date(t).toISOString().slice(0, 10)}`;
}

const KIND_LABEL: Record<PermissionKind, string> = {
  geolocation: "Location",
  notifications: "Notifications",
};

const STATE_LABEL: Record<StoredPermissionState, string> = {
  granted: "allowed",
  denied: "blocked",
  prompt: "not asked",
  dismissed: "not now",
  unsupported: "unavailable",
};

/** "Location allowed", "Location not asked" (nothing recorded yet). */
export function permissionChip(
  kind: PermissionKind,
  permission: StoredPermission | null,
): string {
  return `${KIND_LABEL[kind]} ${permission ? STATE_LABEL[permission.state] : "not asked"}`;
}

/** The one line a person needs about how to undo a block. */
export function blockedHint(
  permission: StoredPermission | null,
): string | null {
  return permission?.state === "denied"
    ? "Blocked in your browser. Allow location for this site in your browser settings."
    : null;
}

/** "Light theme · 2 saved places · 3 activities" for this device. */
export function preferencesSummary(prefs: DevicePreferencesSnapshot): string {
  const theme =
    prefs.theme === "system"
      ? "System theme"
      : `${prefs.theme === "dark" ? "Dark" : "Light"} theme`;
  const places = prefs.savedLocations.length;
  const acts = prefs.selectedActivities.length;
  return [
    theme,
    `${places} saved ${places === 1 ? "place" : "places"}`,
    `${acts} ${acts === 1 ? "activity" : "activities"}`,
  ].join(" · ");
}
