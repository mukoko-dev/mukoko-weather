/**
 * Device weather store — reads and writes the `weather_places` RxDB
 * collection (IndexedDB). The rules (what is stored, how old is too old,
 * what gets evicted) are in `src/lib/device-weather.ts`.
 *
 * Every function is best-effort and never throws: on the server, in a
 * private window, after Safari's 7-day wipe or with storage full, reads come
 * back empty and writes are dropped, so the app behaves as if nothing was
 * stored.
 */

import {
  type DashboardPayload,
  type DeviceView,
  type StoredPlaceMeta,
  deviceViewOf,
  forecastEndsAt,
  isQuotaError,
  parsePayload,
  planEviction,
  serialisePayload,
  servedStaleAgeMs,
} from "../device-weather";
import { canonicalSlug, storageKeySlug } from "../slug-migration";
import { forgetHomeSnapshot, rememberHomeSnapshot } from "../home-snapshot";
import type { WeatherPlaceDocType } from "./schemas";
import {
  markNoPlacesStored,
  markPlacesStored,
  placesMayExist,
} from "./places-marker";
import { storageMayStart } from "./start-gate";

/** The slice of an RxDB collection this module uses (so tests can fake it). */
export interface PlaceCollection {
  findOne(slug: string): { exec(): Promise<PlaceDoc | null> };
  find(): { exec(): Promise<PlaceDoc[]> };
  upsert(doc: WeatherPlaceDocType): Promise<unknown>;
  bulkRemove(ids: string[]): Promise<unknown>;
}

/** A stored document — RxDB documents expose their fields as properties. */
export type PlaceDoc = WeatherPlaceDocType & {
  incrementalPatch?: (patch: Partial<WeatherPlaceDocType>) => Promise<unknown>;
};

type CollectionSource = () => Promise<PlaceCollection | null>;

async function defaultCollection(): Promise<PlaceCollection | null> {
  if (typeof window === "undefined") return null;
  try {
    const { getDatabase } = await import("./database");
    const db = await getDatabase();
    return (db?.weather_places as unknown as PlaceCollection) ?? null;
  } catch {
    return null;
  }
}

let source: CollectionSource = defaultCollection;

// ---------------------------------------------------------------------------
// Change notices (the bell's alerts read these places)
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();

/**
 * Be told when a place was stored or the store was cleared, so the bell can
 * look again (never on a timer). Returns the unsubscribe function.
 */
export function subscribePlaces(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyPlaces(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // a listener must never break a write
    }
  }
}

/** Tests only: swap the collection source (null restores the default). */
export function _setPlaceCollectionSource(next: CollectionSource | null): void {
  source = next ?? defaultCollection;
}

async function collection(): Promise<PlaceCollection | null> {
  try {
    return await source();
  } catch {
    return null;
  }
}

/**
 * The collection for a READ of stored places. A device that holds none has
 * nothing to read, and opening the database to find that out (about 350 KB of
 * JavaScript, then IndexedDB) is the work a first visit skips (places-marker.ts,
 * issue 551). Only the real database is skipped this way; a test's own source
 * is always asked. Writers use `collection()`: they must open it.
 */
async function readCollection(): Promise<PlaceCollection | null> {
  if (source === defaultCollection && !(await placesMayExist())) return null;
  return collection();
}

function metaOf(doc: PlaceDoc): StoredPlaceMeta {
  return {
    slug: doc.slug,
    fetchedAt: doc.fetchedAt,
    lastAccessedAt: doc.lastAccessedAt,
    expiresAt: doc.expiresAt,
    bytes: doc.bytes,
  };
}

async function evict(
  col: PlaceCollection,
  pinned: ReadonlySet<string>,
  now: number,
  limits?: { maxPlaces: number; maxBytes: number },
): Promise<void> {
  const docs = await col.find().exec();
  const remove = planEviction(docs.map(metaOf), pinned, now, limits);
  if (remove.length) await col.bulkRemove(remove);
}

export interface RememberOptions {
  /** Slugs never evicted for space: the current location and saved places. */
  pinned?: Iterable<string>;
  /** When the payload came off the network. Defaults to now. */
  fetchedAt?: number;
  now?: number;
}

/**
 * Store the last good payload for a place. Returns true when it was stored.
 * On a storage-full error it evicts every unpinned place and tries once more.
 */
export async function rememberPlace(
  payload: DashboardPayload,
  opts: RememberOptions = {},
): Promise<boolean> {
  const serialised = serialisePayload(payload);
  if (!serialised) return false;
  const expiresAt = forecastEndsAt(payload.weather);
  if (expiresAt === null) return false;
  const now = opts.now ?? Date.now();
  const pinned = new Set(opts.pinned ?? []);
  pinned.add(payload.location.slug);
  const doc: WeatherPlaceDocType = {
    slug: payload.location.slug,
    payload: serialised.json,
    // A forecast the Worker served stale keeps the age it had: the device must
    // not call a day-old row "just now".
    fetchedAt: opts.fetchedAt ?? now - (servedStaleAgeMs(payload.weather) ?? 0),
    lastAccessedAt: now,
    expiresAt,
    bytes: serialised.bytes,
  };

  // Writing the copy back is not needed to paint: on the home page it waits
  // for the weather to be on screen (start-gate.ts).
  await storageMayStart();
  const col = await collection();
  if (!col) return false;
  // Before the write, so the marker is never behind what is stored.
  markPlacesStored();
  try {
    await col.upsert(doc);
  } catch (err) {
    if (!isQuotaError(err)) return false;
    try {
      // Storage is full: keep only what the visitor pinned, then retry once.
      await evict(col, pinned, now, { maxPlaces: 0, maxBytes: 0 });
      await col.upsert(doc);
    } catch {
      return false;
    }
  }
  try {
    await evict(col, pinned, now);
  } catch {
    // Eviction is housekeeping — the write itself succeeded.
  }
  // The quick copy of My Location (src/lib/home-snapshot.ts) must not fall
  // behind the stored copy of the same place: it is read first. Only a copy
  // that exists is refreshed; this never makes one.
  rememberHomeSnapshot(payload, doc.fetchedAt, now, { onlyIfHeld: true });
  notifyPlaces();
  return true;
}

/**
 * The stored view for one place, re-based on "now" — or null when nothing
 * usable is stored. A corrupt or expired record is deleted on the way.
 */
export async function recallPlace(
  slug: string,
  now: number = Date.now(),
): Promise<DeviceView | null> {
  if (!slug) return null;
  const col = await readCollection();
  if (!col) return null;
  try {
    // A shipped place has two spellings (#317). A copy stored before the move
    // sits under the legacy slug, one stored since under the canonical one;
    // whichever is asked for finds whichever is there, and the view always
    // carries the canonical slug, so the place on screen, its URL and its
    // memory entry are one. A slug that is not in the pinned table has one
    // spelling and is looked up as it always was.
    const canonical = canonicalSlug(slug);
    let doc: PlaceDoc | null = null;
    // The canonical copy first: it can only have been stored since the move.
    for (const key of new Set([canonical, storageKeySlug(slug)])) {
      doc = await col.findOne(key).exec();
      if (doc) break;
    }
    if (!doc) return null;
    const stored = parsePayload(doc.payload);
    const payload =
      stored && stored.location.slug !== canonical
        ? { ...stored, location: { ...stored.location, slug: canonical } }
        : stored;
    const view = payload
      ? deviceViewOf({ payload, fetchedAt: doc.fetchedAt }, now)
      : null;
    if (!view) {
      await col.bulkRemove([doc.slug]).catch(() => {});
      return null;
    }
    void doc.incrementalPatch?.({ lastAccessedAt: now })?.catch?.(() => {});
    return view;
  } catch {
    return null;
  }
}

export interface ListedPlace extends DeviceView {
  slug: string;
  lastAccessedAt: number;
}

/** Every usable stored place, most recently viewed first. */
export async function listPlaces(
  now: number = Date.now(),
): Promise<ListedPlace[]> {
  const col = await readCollection();
  if (!col) return [];
  try {
    const docs = await col.find().exec();
    const out: ListedPlace[] = [];
    const broken: string[] = [];
    for (const doc of docs) {
      const payload = parsePayload(doc.payload);
      const view = payload
        ? deviceViewOf({ payload, fetchedAt: doc.fetchedAt }, now)
        : null;
      if (view)
        out.push({
          ...view,
          slug: doc.slug,
          lastAccessedAt: doc.lastAccessedAt,
        });
      else broken.push(doc.slug);
    }
    if (broken.length) await col.bulkRemove(broken).catch(() => {});
    return out.sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
  } catch {
    return [];
  }
}

export interface ReadPlace extends DeviceView {
  slug: string;
}

/**
 * The stored views for these places, re-based on "now", in the order asked.
 * READ-ONLY: unlike `recallPlace` it does not touch `lastAccessedAt` (looking
 * at the alerts must not make a place look recently viewed) and deletes
 * nothing; a missing, corrupt or expired place is simply left out.
 */
export async function readPlaces(
  slugs: readonly string[],
  now: number = Date.now(),
): Promise<ReadPlace[]> {
  const wanted = [...new Set(slugs.filter(Boolean).map(canonicalSlug))];
  if (wanted.length === 0) return [];
  const col = await readCollection();
  if (!col) return [];
  const out: ReadPlace[] = [];
  for (const canonical of wanted) {
    try {
      // A shipped place has two spellings (see `recallPlace`): a copy stored
      // before the move sits under the legacy slug. Either is found, and the
      // place always carries the canonical slug.
      let doc: PlaceDoc | null = null;
      for (const key of new Set([canonical, storageKeySlug(canonical)])) {
        doc = await col.findOne(key).exec();
        if (doc) break;
      }
      if (!doc) continue;
      const stored = parsePayload(doc.payload);
      const payload =
        stored && stored.location.slug !== canonical
          ? { ...stored, location: { ...stored.location, slug: canonical } }
          : stored;
      const view = payload
        ? deviceViewOf({ payload, fetchedAt: doc.fetchedAt }, now)
        : null;
      if (view) out.push({ ...view, slug: canonical });
    } catch {
      // one unreadable place never hides the others
    }
  }
  return out;
}

/** Count and bytes of what is stored (for the Settings storage row). */
export async function placesUsage(): Promise<{ count: number; bytes: number }> {
  const col = await readCollection();
  if (!col) return { count: 0, bytes: 0 };
  try {
    const docs = await col.find().exec();
    return {
      count: docs.length,
      bytes: docs.reduce((s, d) => s + (d.bytes || 0), 0),
    };
  } catch {
    return { count: 0, bytes: 0 };
  }
}

/** Delete every stored place. Returns how many were removed. */
export async function clearPlaces(): Promise<number> {
  // The quick copy of My Location goes with the stored places.
  forgetHomeSnapshot();
  const col = await readCollection();
  if (!col) return 0;
  try {
    const docs = await col.find().exec();
    if (docs.length) await col.bulkRemove(docs.map((d) => d.slug));
    // Nothing is stored now: the next visit need not open the database to
    // find out (places-marker.ts).
    markNoPlacesStored();
    if (docs.length) notifyPlaces();
    return docs.length;
  } catch {
    return 0;
  }
}
