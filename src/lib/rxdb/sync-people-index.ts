/**
 * Whose local sync databases exist on this browser (#396): person ids and
 * nothing else.
 *
 * Why it exists. The CouchDB sync keeps one RxDB database per person
 * (`mukoko_weather_sync_<personId>`, `couch-rxdb.ts`) holding their settings and
 * activities. It must not outlive that person's sign-in on this browser or be
 * there for the next person, and a browser cannot list IndexedDB databases
 * portably, so the sync records the ids it created here. Sign-out (the session
 * route answering 401) and a different person being issued then find them and
 * remove them (`purgeUserDocStores`).
 *
 * What it holds. A JSON array of person ids under one `localStorage` key, via
 * `safe-storage` (SSR-safe, never throws). No token, no setting, no activity,
 * no name or email: a person id is the opaque platform id that is already in
 * the name of the database it points at. It is only ever written once the
 * sync has started, which only happens with `FLAGS.couch_sync` on, so with the
 * flag off this module is never reached and nothing is created.
 *
 * It is a separate module from the `couch-*` files on purpose: those are
 * guarded against touching web storage because the credential must live in
 * memory only (`couch-sync-flag-off.test.ts`); this holds no credential, and
 * `sync-people-index.test.ts` pins that.
 */

import { readStorage, removeStorage, writeStorage } from "../safe-storage";

export const SYNC_PEOPLE_KEY = "mukoko-sync-people";
/** The shape of a platform person id (the same one `couch-docs.ts` accepts). */
const PERSON_ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
/** More than this is not a browser anyone shares; stop recording. */
const MAX_PEOPLE = 8;

/** The recorded person ids, in the order they were recorded. Never throws. */
export function recordedSyncPeople(): string[] {
  const raw = readStorage(SYNC_PEOPLE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const ids = parsed.filter(
      (v): v is string => typeof v === "string" && PERSON_ID_RE.test(v),
    );
    return [...new Set(ids)].slice(0, MAX_PEOPLE);
  } catch {
    return [];
  }
}

function save(ids: string[]): void {
  if (ids.length === 0) removeStorage(SYNC_PEOPLE_KEY);
  else writeStorage(SYNC_PEOPLE_KEY, JSON.stringify(ids));
}

/** Note that this person's local sync database exists (or is about to). */
export function recordSyncPerson(personId: string): void {
  if (!PERSON_ID_RE.test(personId)) return;
  const ids = recordedSyncPeople();
  if (ids.includes(personId)) return;
  save([...ids, personId].slice(-MAX_PEOPLE));
}

/** Note that this person's local sync database is gone. */
export function forgetSyncPerson(personId: string): void {
  const ids = recordedSyncPeople();
  if (!ids.includes(personId)) return;
  save(ids.filter((id) => id !== personId));
}
