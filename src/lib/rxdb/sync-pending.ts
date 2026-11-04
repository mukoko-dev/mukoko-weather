/**
 * Changes the person made that are not written to documents yet (#396): the
 * engine's `ChangeJournal`, kept in web storage so a change is never only in
 * memory.
 *
 * Why it exists. The sync writes a setting to the local database a moment
 * after the person changes it (a 750 ms debounce), and the local database may
 * not be open yet at all (a person's first session, or the credential failing).
 * A page that closes in between used to take the change with it: the next page
 * started from the state it found, saw no difference, pulled the server's older
 * value and replaced the person's choice with it. So the engine writes this
 * record the moment a change is made, synchronously (it completes on a page
 * that is going away), and the next page's engine starts its comparison from
 * `base`, the state before the first unwritten change, and stamps what it
 * writes with `at`, when the person made it.
 *
 * What it holds. `{ at, base: { theme, selectedForecastModel,
 * selectedActivities } }` under one `localStorage` key via `safe-storage`
 * (SSR-safe, never throws): a time and the three non-locational settings the
 * sync owns, which are also in this browser's own preferences. No credential,
 * no place, no name, no email. It is removed as soon as the changes are in
 * documents, and on sign-out. It is only reached once the sync has started,
 * which only happens with `FLAGS.couch_sync` on, so with the flag off nothing
 * is written.
 *
 * A separate module from the `couch-*` files on purpose, like
 * `sync-people-index.ts`: those are guarded against touching web storage
 * because the credential must live in memory only
 * (`couch-sync-flag-off.test.ts`); this holds no credential, and
 * `sync-pending.test.ts` pins that.
 */

import { readStorage, removeStorage, writeStorage } from "../safe-storage";
import type { ChangeJournal, JournalRecord } from "./couch-sync";

export const SYNC_PENDING_KEY = "mukoko-sync-unwritten";

/** Bounds: a record outside them is not one this client wrote. */
const MAX_RAW_CHARS = 8_192;
const MAX_ACTIVITIES = 100;
const MAX_VALUE_CHARS = 64;

function isShortString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_VALUE_CHARS;
}

/** The record as it will be stored: only the known fields, or null if unfit. */
function tidy(value: unknown): JournalRecord | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { at?: unknown; base?: unknown };
  if (typeof v.at !== "number" || !Number.isFinite(v.at) || v.at <= 0) {
    return null;
  }
  if (!v.base || typeof v.base !== "object") return null;
  const b = v.base as {
    theme?: unknown;
    selectedForecastModel?: unknown;
    selectedActivities?: unknown;
  };
  if (!isShortString(b.theme) || !isShortString(b.selectedForecastModel)) {
    return null;
  }
  const acts = b.selectedActivities;
  if (
    !Array.isArray(acts) ||
    acts.length > MAX_ACTIVITIES ||
    !acts.every(isShortString)
  ) {
    return null;
  }
  return {
    at: v.at,
    base: {
      theme: b.theme,
      selectedForecastModel: b.selectedForecastModel,
      selectedActivities: [...acts],
    },
  };
}

export const syncJournal: ChangeJournal = {
  read(): JournalRecord | null {
    const raw = readStorage(SYNC_PENDING_KEY);
    if (!raw || raw.length > MAX_RAW_CHARS) return null;
    try {
      return tidy(JSON.parse(raw));
    } catch {
      return null;
    }
  },

  write(record: JournalRecord): void {
    const tidied = tidy(record);
    if (!tidied) return;
    writeStorage(SYNC_PENDING_KEY, JSON.stringify(tidied));
  },

  clear(): void {
    removeStorage(SYNC_PENDING_KEY);
  },
};
