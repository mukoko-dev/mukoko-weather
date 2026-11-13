/**
 * "Does this device hold any stored place?", answered without opening the
 * database (issue 551).
 *
 * The stage asks the device for a stored copy of its place before it asks the
 * network (`recallPlace`). Opening the on-device database to ask is real work:
 * about 350 KB of JavaScript to fetch and run, then IndexedDB and the
 * collections. On a first visit there cannot be a copy, so that work, and the
 * wait for it (up to the place controller's recall timeout), came before the
 * weather for nothing.
 *
 * One localStorage key says which case a device is in:
 *
 * - `"1"`: a place may be stored here. Written just BEFORE the first write of
 *   one (`rememberPlace`), so it is never behind what is stored.
 * - `"0"`: nothing is stored here: set when a visit found no database at all,
 *   and by `clearPlaces` once it has removed everything.
 * - absent: not known. A device that stored places before this marker existed
 *   has none, and so does a browser whose storage was cleared on its own. The
 *   database is then looked for BY NAME (`indexedDB.databases()`, which opens
 *   nothing): found, the marker becomes `"1"` and the visit goes on exactly as
 *   it did; not found, the marker becomes `"0"`.
 *
 * Whatever cannot be established goes on as it did: no `window`, no
 * `indexedDB.databases` (older Firefox), a listing that fails or does not
 * answer within `PROBE_TIMEOUT_MS`. The only answer that skips the database is
 * a positive "nothing here", so a visit with anything stored behaves as before.
 * With localStorage blocked, the marker cannot be kept and the listing is asked
 * once per page load instead.
 */
import { readStorage, removeStorage, writeStorage } from "../safe-storage";

export const PLACES_MARKER_KEY = "mukoko-places-stored";

/** How long the listing of databases is waited for. It opens nothing; it is quick. */
export const PROBE_TIMEOUT_MS = 150;

/** The database RxDB opens (src/lib/rxdb/database.ts); its storage names contain it. */
const DATABASE_NAME = "mukoko_weather";

let probe: Promise<boolean> | null = null;

/** A place is about to be stored (or may be): never skip the database again. */
export function markPlacesStored(): void {
  // A full or blocked localStorage may refuse the write while it still holds an
  // older "0": take that away, which removal can do even when a write cannot,
  // so the next visit does not read a stale "nothing is stored here".
  if (!writeStorage(PLACES_MARKER_KEY, "1")) removeStorage(PLACES_MARKER_KEY);
  // With localStorage blocked the key cannot hold this: the page still knows.
  probe = Promise.resolve(true);
}

/** Every stored place was removed: the next visit has nothing to read. */
export function markNoPlacesStored(): void {
  writeStorage(PLACES_MARKER_KEY, "0");
  probe = Promise.resolve(false);
}

async function listsDatabase(): Promise<boolean> {
  const idb = typeof indexedDB === "undefined" ? null : indexedDB;
  if (!idb || typeof idb.databases !== "function") return true;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const names = await Promise.race([
      idb.databases().then((list) => list.map((db) => db.name ?? "")),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    // No answer in time: go on as before.
    if (names === null) return true;
    const found = names.some((name) => name.includes(DATABASE_NAME));
    if (found) writeStorage(PLACES_MARKER_KEY, "1");
    else writeStorage(PLACES_MARKER_KEY, "0");
    return found;
  } catch {
    return true;
  }
}

/**
 * False only when this device is known to hold no stored place. A reader that
 * gets false has nothing to read and need not open the database.
 */
export function placesMayExist(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(true);
  const marker = readStorage(PLACES_MARKER_KEY);
  if (marker === "0") return Promise.resolve(false);
  if (marker === "1") return Promise.resolve(true);
  probe ??= listsDatabase();
  return probe;
}

/** Tests only: a fresh page. */
export function _resetPlacesMarker(): void {
  probe = null;
}
