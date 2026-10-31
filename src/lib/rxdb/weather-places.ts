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
} from "../device-weather";
import type { WeatherPlaceDocType } from "./schemas";

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
    fetchedAt: opts.fetchedAt ?? now,
    lastAccessedAt: now,
    expiresAt,
    bytes: serialised.bytes,
  };

  const col = await collection();
  if (!col) return false;
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
  const col = await collection();
  if (!col) return null;
  try {
    const doc = await col.findOne(slug).exec();
    if (!doc) return null;
    const payload = parsePayload(doc.payload);
    const view = payload
      ? deviceViewOf({ payload, fetchedAt: doc.fetchedAt }, now)
      : null;
    if (!view) {
      await col.bulkRemove([slug]).catch(() => {});
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
  const col = await collection();
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

/** Count and bytes of what is stored (for the Settings storage row). */
export async function placesUsage(): Promise<{ count: number; bytes: number }> {
  const col = await collection();
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
  const col = await collection();
  if (!col) return 0;
  try {
    const docs = await col.find().exec();
    if (docs.length) await col.bulkRemove(docs.map((d) => d.slug));
    return docs.length;
  } catch {
    return 0;
  }
}
