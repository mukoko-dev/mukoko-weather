/**
 * Keeps the alerts current without polling (mukoko-dev/mukoko-weather#289).
 *
 * `watchAlerts` reads the alerts once, then again only when something the
 * alerts are made of changed: a place was stored in the device store, a
 * reports read settled in the shared Worker store, the person's places or
 * alert choices changed, or the tab became visible again. No timer, no request
 * (see `alerts-source.ts`). It is a plain function, not a hook, so the header
 * can load it on demand and keep it out of the first-load JavaScript.
 */

import type { Alert, AlertsResult } from "./alerts";
import { alertPlaceSlugs, loadAlerts, peekReports } from "./alerts-source";
import { LAST_HOME_PLACE_KEY } from "./last-location";
import {
  filterAlertsByPrefs,
  isQuietNow,
  type NotificationPrefs,
} from "./notification-prefs";
import { subscribePlaces } from "./rxdb/weather-places";
import { readStorage } from "./safe-storage";
import { useAppStore } from "./store";
import { workerData } from "./worker-data";

export interface AlertSnapshot {
  /** Everything found, before the person's choices. */
  result: AlertsResult;
  /** The alerts of the kinds the person has switched on. */
  shown: Alert[];
  /** Inside the person's quiet hours right now. */
  quiet: boolean;
  /** When this was worked out (epoch ms). */
  at: number;
}

/** The store fields the alerts depend on. */
function watchedKey(s: ReturnType<typeof useAppStore.getState>): string {
  return JSON.stringify([
    s.selectedLocation,
    s.homeLocation,
    s.savedLocations,
    s.notificationPrefs,
  ]);
}

/** Pure part: turn a result and the person's choices into what to show. */
export function snapshotOf(
  result: AlertsResult,
  prefs: NotificationPrefs,
  now: Date,
): AlertSnapshot {
  return {
    result,
    shown: filterAlertsByPrefs(result.alerts, prefs),
    quiet: isQuietNow(prefs, now),
    at: now.getTime(),
  };
}

/** The places the alerts look at right now. */
function currentSlugs(): string[] {
  const state = useAppStore.getState();
  return alertPlaceSlugs({
    selectedLocation: state.selectedLocation,
    homeLocation: state.homeLocation,
    lastHomePlace: readStorage(LAST_HOME_PLACE_KEY),
    savedLocations: state.savedLocations,
  });
}

/**
 * A cheap fingerprint of the reports held for those places. The shared Worker
 * store tells the watch about EVERY read that settles (weather, air quality,
 * ...); only a change here is worth a new look.
 */
function reportsSignature(slugs: readonly string[]): string {
  return slugs
    .map((slug) => {
      const reports = peekReports(slug);
      return reports
        ? `${reports.length}:${reports[0]?.reportedAt ?? ""}`
        : "-";
    })
    .join("|");
}

export function watchAlerts(
  onSnapshot: (snapshot: AlertSnapshot) => void,
  { debounceMs = 250 }: { debounceMs?: number } = {},
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let run = 0;

  const read = async () => {
    const mine = ++run;
    const state = useAppStore.getState();
    const slugs = currentSlugs();
    const now = new Date();
    try {
      const result = await loadAlerts(
        slugs,
        { labels: state.locationLabels, names: state.locationNames },
        now,
      );
      // Only the latest read may speak, and not after the watch was stopped.
      if (stopped || mine !== run) return;
      onSnapshot(
        snapshotOf(result, useAppStore.getState().notificationPrefs, now),
      );
    } catch {
      // Alerts are supplementary: a failed read leaves the last snapshot.
    }
  };

  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void read();
    }, debounceMs);
  };

  const offPlaces = subscribePlaces(schedule);
  let lastReports = reportsSignature(currentSlugs());
  const offReports = workerData.subscribe(() => {
    const signature = reportsSignature(currentSlugs());
    if (signature === lastReports) return;
    lastReports = signature;
    schedule();
  });
  let lastKey = watchedKey(useAppStore.getState());
  const offStore = useAppStore.subscribe((s) => {
    const key = watchedKey(s);
    if (key === lastKey) return;
    lastKey = key;
    schedule();
  });
  const onVisible = () => {
    if (document.visibilityState === "visible") schedule();
  };
  document.addEventListener("visibilitychange", onVisible);

  void read();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    offPlaces();
    offReports();
    offStore();
    document.removeEventListener("visibilitychange", onVisible);
  };
}
