/**
 * What the rest of the app may know about the person-preferences sync
 * (mukoko-dev/mukoko-weather#484): whether it is running, and which of the
 * device's activities it could not take onto the profile. Two values in module
 * memory and nothing else, in a module of their own so the legacy device-profile
 * replication (`rxdb/replication.ts`) can read the first without loading the sync.
 */

let active = false;
let overflow: readonly string[] = [];

/**
 * True while the sync is running for a signed-in person. The legacy
 * `/v1/devices` pull then leaves the device's activities alone, so two syncs
 * of one list do not overwrite each other (`replication.ts`).
 */
export function isPersonSyncActive(): boolean {
  return active;
}

export function setPersonSyncActive(value: boolean): void {
  active = value;
  if (!value) overflow = [];
}

/**
 * The device's activities beyond the profile's cap: kept on this device, not
 * on the profile, so they do not follow the person. Empty when all fit. A UI
 * that says so, or stops the selection at the cap, can read this; none does
 * yet (a follow-up).
 */
export function getPersonSyncOverflow(): readonly string[] {
  return overflow;
}

export function setPersonSyncOverflow(ids: readonly string[]): void {
  overflow = [...ids];
}
