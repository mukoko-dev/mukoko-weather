/**
 * The three settings the CouchDB sync owns, compared and copied BY VALUE
 * (#396). Dependency free on purpose: `store.ts` (first-load JavaScript) and the
 * sync engine both import it, so "is this a change?" has one answer.
 *
 * Why by value. The app's RxDB preferences bridge sets a FRESH array into the
 * store on every emission of the preferences document (a place switch, a
 * `/v1/devices` pull, another tab), so comparing `selectedActivities` by
 * reference called each of those a change the person made: it re-stamped the
 * setting with the current time (beating a newer value from another device) and
 * wrote the unwritten-change record on every place switch. A change is a
 * difference in what the settings ARE: same members in the same order is none.
 */

import type { SyncableState } from "./couch-docs";

/** Same theme, same model, same activities in the same order. */
export function sameSyncableState(a: SyncableState, b: SyncableState): boolean {
  return (
    a.theme === b.theme &&
    a.selectedForecastModel === b.selectedForecastModel &&
    a.selectedActivities.length === b.selectedActivities.length &&
    a.selectedActivities.every((id, i) => id === b.selectedActivities[i])
  );
}

/** A copy that shares nothing with the original (the array is new). */
export function cloneSyncableState(s: SyncableState): SyncableState {
  return {
    theme: s.theme,
    selectedForecastModel: s.selectedForecastModel,
    selectedActivities: [...s.selectedActivities],
  };
}
