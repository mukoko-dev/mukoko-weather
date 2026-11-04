/**
 * Where a signed-in person's activities and saved places are kept: the ONE
 * storage module. INTERIM HOME. The truth moves to the person's own CouchDB
 * database (`user_<personId>`, nyuchi/data-infra ADR-0002, owner decisions in
 * mukoko-dev/mukoko-weather#396); this is the projection that works until
 * that sync is live, and the move is meant to be a copy, not a redesign: every
 * item here has the shape of the `activity` and `savedPlace` documents of
 * `schemas/model/userdb.yaml`, one array entry per document.
 *
 * ONE FILE TO CHANGE. The route (`app/api/profile/preferences`), the browser
 * merge (`person-preferences-sync.ts`) and their tests never name a database,
 * a collection or a field of the store: they talk to
 * {@link PersonPreferencesStore}. If the home moves (the person's CouchDB
 * database, another record, another service), this is the only file that
 * changes. `person-preferences-boundary.test.ts` fails if that stops being
 * true.
 *
 * WHERE IT LIVES NOW. The signed-in person's OWN record in `identity.persons`
 * (owner decision, 2026-11-04: "the most logical and the easiest to migrate"),
 * written like `updateMyName` in `profile.ts` and `updateProfileAction`:
 * matched on the verified WorkOS user id from the session (never an id from
 * the request), through the shared `identityDb()` accessor of `mongo.ts`, an
 * allowlist of two fields (and the record's `updatedAt`), no upsert (the
 * record is made at sign-in by `upsertPlatformPerson`; making one here could
 * race that). No new client, no new URL, and no collection or index is created
 * from this code.
 *
 *   activities:  [{ activityId, createdAt, updatedAt, tombstone }]
 *   savedPlaces: [{ savedPlaceId, createdAt, updatedAt, tombstone, envelope }]
 *
 * The two fields are PROPOSED slots on `Person` in nyuchi/data-infra
 * (`schemas/model/identity.yaml`); until nyuchi has applied them the route is
 * off (`PERSON_PREFERENCES_READY`). Fields that become dead when the CouchDB
 * sync goes live are listed in docs/mongodb-schema-map.md.
 *
 * ONE WRITE PER SYNC. A merge reads the record, merges with the pure
 * {@link mergeById} (later `updatedAt` wins, a tie leaves the stored item),
 * and writes the changed list(s) and the record's `updatedAt` in ONE
 * `updateOne`, guarded on the `updatedAt` it read. If something else wrote the
 * record in between (another device, a name edit), the guard matches nothing:
 * it reads and merges again, once, and then gives up with
 * {@link PreferencesConflictError} (the route answers a retryable 503). So the
 * caps are judged on exactly what is written, `updatedAt` moves once, a request
 * that changes nothing writes nothing, and a field that is `null` or absent
 * (the proposed validator allows null) is replaced whole instead of failing on
 * an array operator. Entries this code cannot read (a newer writer's, extra
 * fields on a known one) are written back as they were found.
 */

import { identityDb } from "./mongo";
import {
  ACTIVITY_ID_RE,
  SAVED_PLACE_ID_RE,
  TOMBSTONE_RETENTION_MS,
  activityIdOf,
  capProblem,
  mergeById,
  parseEnvelope,
  savedPlaceIdOf,
  toWireTime,
  type ActivityItem,
  type PersonPreferencesPatch,
  type Problem,
  type SavedPlaceItem,
  type Versioned,
} from "./person-preferences";

/** What a person has stored, tombstones included. */
export interface StoredPreferences {
  activities: ActivityItem[];
  savedPlaces: SavedPlaceItem[];
}

export type MergeResult =
  | { kind: "ok"; stored: StoredPreferences }
  /** There is no active record for this person (sign-in makes it). */
  | { kind: "no_person" }
  /** Nothing was applied: the merge would break a cap. */
  | { kind: "refused"; problem: Problem };

export interface PersonPreferencesStore {
  /** The person's items, or null when the person has no active record. */
  read(workosUserId: string): Promise<StoredPreferences | null>;
  /**
   * Merge a patch item by item (later `updatedAt` wins). Atomic in effect:
   * a refusal applies nothing, and one request is one write. Throws when the
   * store cannot be reached, or {@link PreferencesConflictError} when the
   * record kept changing under it.
   */
  merge(
    workosUserId: string,
    patch: PersonPreferencesPatch,
    now: Date,
  ): Promise<MergeResult>;
}

/** The record changed between the read and the write, twice running. */
export class PreferencesConflictError extends Error {
  constructor() {
    super("The record changed while it was being written");
    this.name = "PreferencesConflict";
  }
}

type Doc = Record<string, unknown>;

/** The few collection calls used, so a test can stand a fake in its place. */
export interface PersonsCollectionLike {
  findOne(filter: Doc, options?: { projection?: Doc }): Promise<Doc | null>;
  updateOne(filter: Doc, update: Doc): Promise<{ matchedCount: number }>;
}

const isRecord = (v: unknown): v is Doc =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const validDate = (v: unknown): Date | null =>
  v instanceof Date && !Number.isNaN(v.getTime()) ? v : null;

/** One stored entry to an item, or null when it is not one this code wrote. */
function activityFromStored(raw: unknown): ActivityItem | null {
  if (!isRecord(raw)) return null;
  const id = raw.activityId;
  const created = validDate(raw.createdAt);
  const updated = validDate(raw.updatedAt);
  if (typeof id !== "string" || !ACTIVITY_ID_RE.test(id)) return null;
  if (!created || !updated || typeof raw.tombstone !== "boolean") return null;
  return {
    activityId: id,
    createdAt: toWireTime(created),
    updatedAt: toWireTime(updated),
    tombstone: raw.tombstone,
  };
}

function savedPlaceFromStored(raw: unknown): SavedPlaceItem | null {
  if (!isRecord(raw)) return null;
  const id = raw.savedPlaceId;
  const created = validDate(raw.createdAt);
  const updated = validDate(raw.updatedAt);
  if (typeof id !== "string" || !SAVED_PLACE_ID_RE.test(id)) return null;
  if (!created || !updated || typeof raw.tombstone !== "boolean") return null;
  const base = {
    savedPlaceId: id,
    createdAt: toWireTime(created),
    updatedAt: toWireTime(updated),
    tombstone: raw.tombstone,
  };
  if (raw.tombstone) return base;
  const envelope = parseEnvelope(raw.envelope, id);
  return envelope ? { ...base, envelope } : null;
}

/** One stored list: what was read, and what must survive a write untouched. */
interface Listed<T> {
  items: T[];
  /** The entry as found, by item id. */
  raw: Map<string, Doc>;
  /** Entries this code cannot read: written back as they are. */
  foreign: unknown[];
}

function listFrom<T>(
  stored: unknown,
  read: (v: unknown) => T | null,
  idOf: (t: T) => string,
): Listed<T> {
  const out: Listed<T> = { items: [], raw: new Map(), foreign: [] };
  // `null` or absent (the validator allows null) is an empty list.
  if (!Array.isArray(stored)) return out;
  for (const entry of stored) {
    const item = read(entry);
    if (item === null) {
      out.foreign.push(entry);
      continue;
    }
    out.items.push(item);
    out.raw.set(idOf(item), entry as Doc);
  }
  return out;
}

const personFilter = (workosUserId: string): Doc => ({
  workosUserId,
  isActive: { $ne: false },
});

interface Snapshot {
  activities: Listed<ActivityItem>;
  savedPlaces: Listed<SavedPlaceItem>;
  /** The record's `updatedAt` as found: the guard of the write. */
  version: unknown;
  /** The same as a time, when it is one. */
  versionMs: number;
}

async function snapshot(
  col: PersonsCollectionLike,
  workosUserId: string,
): Promise<Snapshot | null> {
  const doc = await col.findOne(personFilter(workosUserId), {
    projection: { activities: 1, savedPlaces: 1, updatedAt: 1 },
  });
  if (!doc) return null;
  return {
    activities: listFrom(doc.activities, activityFromStored, activityIdOf),
    savedPlaces: listFrom(
      doc.savedPlaces,
      savedPlaceFromStored,
      savedPlaceIdOf,
    ),
    version: doc.updatedAt === undefined ? { $exists: false } : doc.updatedAt,
    versionMs: validDate(doc.updatedAt)?.getTime() ?? 0,
  };
}

const sameItem = (
  a: Versioned & { envelope?: unknown },
  b: Versioned & { envelope?: unknown },
) =>
  a.createdAt === b.createdAt &&
  a.updatedAt === b.updatedAt &&
  a.tombstone === b.tombstone &&
  JSON.stringify(a.envelope) === JSON.stringify(b.envelope);

/** Whether merging changed the list: another item, or one that differs. */
function changed<T extends Versioned & { envelope?: unknown }>(
  before: readonly T[],
  merged: readonly T[],
  idOf: (t: T) => string,
): boolean {
  const prev = new Map(before.map((i) => [idOf(i), i]));
  return (
    merged.length !== before.length ||
    merged.some((m) => {
      const p = prev.get(idOf(m));
      return !p || !sameItem(p, m);
    })
  );
}

/** The entries to store: an unchanged one exactly as found, a changed one on top of it. */
function entries<T extends Versioned & { envelope?: unknown }>(
  merged: readonly T[],
  before: readonly T[],
  listed: Listed<T>,
  idOf: (t: T) => string,
  build: (item: T, prior: Doc | undefined) => Doc,
): unknown[] {
  const prev = new Map(before.map((i) => [idOf(i), i]));
  const out: unknown[] = merged.map((item) => {
    const prior = listed.raw.get(idOf(item));
    const was = prev.get(idOf(item));
    return prior && was && sameItem(was, item) ? prior : build(item, prior);
  });
  return [...out, ...listed.foreign];
}

const activityEntry = (item: ActivityItem, prior: Doc | undefined): Doc => ({
  ...prior,
  activityId: item.activityId,
  createdAt: new Date(item.createdAt),
  updatedAt: new Date(item.updatedAt),
  tombstone: item.tombstone,
});

function savedPlaceEntry(item: SavedPlaceItem, prior: Doc | undefined): Doc {
  const base: Doc = { ...prior };
  // A tombstone keeps the common fields and drops the rest.
  delete base.envelope;
  return {
    ...base,
    savedPlaceId: item.savedPlaceId,
    createdAt: new Date(item.createdAt),
    updatedAt: new Date(item.updatedAt),
    tombstone: item.tombstone,
    ...(item.envelope ? { envelope: item.envelope } : {}),
  };
}

/** The `identity.persons` implementation. */
export function createIdentityPersonsStore(
  collection: () => PersonsCollectionLike = () =>
    identityDb().collection("persons") as unknown as PersonsCollectionLike,
): PersonPreferencesStore {
  return {
    async read(workosUserId) {
      const snap = await snapshot(collection(), workosUserId);
      return snap
        ? {
            activities: snap.activities.items,
            savedPlaces: snap.savedPlaces.items,
          }
        : null;
    },

    async merge(workosUserId, patch, now) {
      const col = collection();
      const cutoff = toWireTime(
        new Date(now.getTime() - TOMBSTONE_RETENTION_MS),
      );
      const alive = <T extends Versioned>(items: T[]) =>
        items.filter((i) => !(i.tombstone && i.updatedAt < cutoff));

      // Once, and once more if the record changed under the first attempt.
      for (let attempt = 0; attempt < 2; attempt++) {
        const snap = await snapshot(col, workosUserId);
        if (!snap) return { kind: "no_person" };

        // Judge the merge against what survives the purge of old tombstones.
        const before = {
          activities: alive(snap.activities.items),
          savedPlaces: alive(snap.savedPlaces.items),
        };
        const merged = {
          activities: mergeById(
            before.activities,
            patch.activities,
            activityIdOf,
          ),
          savedPlaces: mergeById(
            before.savedPlaces,
            patch.savedPlaces,
            savedPlaceIdOf,
          ),
        };
        const problem = capProblem(before, merged);
        if (problem) return { kind: "refused", problem };

        // An empty request, or one that changes nothing, writes nothing.
        const set: Doc = {};
        if (
          patch.activities.length + patch.savedPlaces.length > 0 &&
          changed(snap.activities.items, merged.activities, activityIdOf)
        ) {
          set.activities = entries(
            merged.activities,
            snap.activities.items,
            snap.activities,
            activityIdOf,
            activityEntry,
          );
        }
        if (
          patch.activities.length + patch.savedPlaces.length > 0 &&
          changed(snap.savedPlaces.items, merged.savedPlaces, savedPlaceIdOf)
        ) {
          set.savedPlaces = entries(
            merged.savedPlaces,
            snap.savedPlaces.items,
            snap.savedPlaces,
            savedPlaceIdOf,
            savedPlaceEntry,
          );
        }
        if (Object.keys(set).length === 0) {
          return { kind: "ok", stored: before };
        }

        // The record's updatedAt moves once, and always forward.
        set.updatedAt = new Date(Math.max(now.getTime(), snap.versionMs + 1));
        const result = await col.updateOne(
          { ...personFilter(workosUserId), updatedAt: snap.version },
          { $set: set },
        );
        if (result.matchedCount > 0) return { kind: "ok", stored: merged };
      }
      throw new PreferencesConflictError();
    },
  };
}

/** The store the route uses. */
export const personPreferencesStore: PersonPreferencesStore =
  createIdentityPersonsStore();
