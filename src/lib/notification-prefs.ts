/**
 * What the person chose about alerts, kept on the device
 * (mukoko-dev/mukoko-weather#289). Pure: no storage, no network.
 *
 * Defaults: all four kinds ON in the app, quiet hours OFF. The choices live in
 * the RxDB `preferences` document (`notificationPrefs`, schema v4). The
 * Worker's device-profile sync does not carry them yet, so they are
 * device-local, like `homeLocation`; when push goes live they are the values
 * the app sends with the subscription (the Nyuchi API's `alert_kinds` and
 * `quiet_start` / `quiet_end`, whole hours, two different hours or both
 * absent).
 *
 * Quiet hours are on the PERSON's own clock (this device's), not the place's.
 * In this version they quiet the dot on the bell; the list always shows
 * every alert.
 */

import { ALERT_KINDS, type Alert, type AlertKind } from "./alerts";
import { viewerOffsetSeconds } from "./location-time";

export interface NotificationPrefs {
  frost: boolean;
  lightning: boolean;
  wildfire: boolean;
  flooding: boolean;
  /** First quiet hour on the person's clock (0 to 23), or null when quiet hours are off. */
  quietStart: number | null;
  /** The hour quiet hours end (0 to 23), or null. Always set together with `quietStart`. */
  quietEnd: number | null;
}

export const DEFAULT_NOTIFICATION_PREFS: Readonly<NotificationPrefs> = {
  frost: true,
  lightning: true,
  wildfire: true,
  flooding: true,
  quietStart: null,
  quietEnd: null,
};

/** The "Night" preset: 22:00 to 06:00. */
export const QUIET_NIGHT = { start: 22, end: 6 } as const;

export type QuietMode = "off" | "night" | "custom";

function isHour(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 23;
}

/**
 * Anything stored or typed becomes a valid value: a missing or non-boolean
 * kind is ON, and quiet hours are both set (two different whole hours) or both
 * null, the rule the Nyuchi API applies too.
 */
export function sanitiseNotificationPrefs(raw: unknown): NotificationPrefs {
  const r =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const flag = (k: AlertKind) =>
    typeof r[k] === "boolean" ? (r[k] as boolean) : true;
  const start = r.quietStart;
  const end = r.quietEnd;
  const quiet = isHour(start) && isHour(end) && start !== end;
  return {
    frost: flag("frost"),
    lightning: flag("lightning"),
    wildfire: flag("wildfire"),
    flooding: flag("flooding"),
    quietStart: quiet ? (start as number) : null,
    quietEnd: quiet ? (end as number) : null,
  };
}

/** The prefs with one patch applied, sanitised. */
export function mergeNotificationPrefs(
  current: NotificationPrefs,
  patch: Partial<NotificationPrefs>,
): NotificationPrefs {
  return sanitiseNotificationPrefs({ ...current, ...patch });
}

export function enabledKinds(prefs: NotificationPrefs): AlertKind[] {
  return ALERT_KINDS.filter((k) => prefs[k]);
}

/** Only the alerts of kinds the person has switched on. */
export function filterAlertsByPrefs<T extends Pick<Alert, "kind">>(
  alerts: readonly T[],
  prefs: NotificationPrefs,
): T[] {
  return alerts.filter((a) => prefs[a.kind]);
}

export function quietModeOf(prefs: NotificationPrefs): QuietMode {
  if (prefs.quietStart === null || prefs.quietEnd === null) return "off";
  return prefs.quietStart === QUIET_NIGHT.start &&
    prefs.quietEnd === QUIET_NIGHT.end
    ? "night"
    : "custom";
}

function hh(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/** "Off" or "22:00 to 06:00". */
export function quietLabel(prefs: NotificationPrefs): string {
  return quietModeOf(prefs) === "off"
    ? "Off"
    : `${hh(prefs.quietStart as number)} to ${hh(prefs.quietEnd as number)}`;
}

/**
 * True when `now` is inside the person's quiet hours on their own clock.
 * A window that ends before it starts (22 to 6) runs over midnight. Off is
 * never quiet.
 */
export function isQuietNow(
  prefs: NotificationPrefs,
  now: Date,
  offsetSeconds: number = viewerOffsetSeconds(now),
): boolean {
  if (prefs.quietStart === null || prefs.quietEnd === null) return false;
  const hour = new Date(now.getTime() + offsetSeconds * 1000).getUTCHours();
  const { quietStart: start, quietEnd: end } = prefs;
  return start < end
    ? hour >= start && hour < end
    : hour >= start || hour < end;
}

/** How many kinds are on (for a settings summary). */
export function countEnabled(prefs: NotificationPrefs): number {
  return enabledKinds(prefs).length;
}

/** A short count for a settings row: "3 of 4 on", "All alerts off". */
export function prefsSummary(prefs: NotificationPrefs): string {
  const n = countEnabled(prefs);
  if (n === 0) return "All alerts off";
  return `${n} of ${ALERT_KINDS.length} on`;
}

/** The patch for switching quiet hours on (the Night preset) or off. */
export function quietSwitchPatch(
  on: boolean,
): Pick<NotificationPrefs, "quietStart" | "quietEnd"> {
  return on
    ? { quietStart: QUIET_NIGHT.start, quietEnd: QUIET_NIGHT.end }
    : { quietStart: null, quietEnd: null };
}

/**
 * The patch for picking one end of the quiet window. The two hours must
 * differ (the Nyuchi API refuses equal hours), so picking the hour the other
 * end already has moves the other end one hour on rather than switching
 * quiet hours off behind the person's back.
 */
export function quietEndPatch(
  prefs: NotificationPrefs,
  end: "start" | "end",
  hour: number,
): Pick<NotificationPrefs, "quietStart" | "quietEnd"> {
  const start = prefs.quietStart ?? QUIET_NIGHT.start;
  const stop = prefs.quietEnd ?? QUIET_NIGHT.end;
  if (!isHour(hour)) return { quietStart: start, quietEnd: stop };
  if (end === "start") {
    return {
      quietStart: hour,
      quietEnd: hour === stop ? (hour + 1) % 24 : stop,
    };
  }
  return {
    quietStart: hour === start ? (hour + 23) % 24 : start,
    quietEnd: hour,
  };
}

/** "00:00" to "23:00": the choices in the hour pickers. */
export const QUIET_HOUR_CHOICES: readonly { value: number; label: string }[] =
  Array.from({ length: 24 }, (_, hour) => ({ value: hour, label: hh(hour) }));
