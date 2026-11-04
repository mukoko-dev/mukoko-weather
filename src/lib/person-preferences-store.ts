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
 * written exactly like `updateMyName` in `profile.ts` and
 * `updateProfileAction`: matched on the verified WorkOS user id from the
 * session (never an id from the request), through the shared `identityDb()`
 * accessor of `mongo.ts`, an allowlist of two fields, no upsert (the record is
 * made at sign-in by `upsertPlatformPerson`; making one here could race that).
 * No new client, no new URL, and no collection or index is created from this
 * code.
 *
 *   activities:  [{ activityId, createdAt, updatedAt, tombstone }]
 *   savedPlaces: [{ savedPlaceId, createdAt, updatedAt, tombstone, envelope }]
 *
 * The two fields are PROPOSED slots on `Person` in nyuchi/data-infra
 * (`schemas/model/identity.yaml`); until nyuchi has applied them the route is
 * off (`PERSON_PREFERENCES_READY`). Fields that become dead when the CouchDB
 * sync goes live are listed in docs/mongodb-schema-map.md.
 *
 * CONCURRENCY. Two devices write the same record, so a write never replaces a
 * list: each item is one `$push` (if the person has no such item) and one
 * conditional `$set` (if the stored item is older), each atomic on the
 * document, so two requests in any order give the same lists as the pure
 * {@link mergeById} (later `updatedAt` wins, a tie leaves the stored item).
 */

import { identityDb } from "./mongo";
import {
  ACTIVITY_ID_RE,
  MAX_STORED_ACTIVITIES,
  MAX_STORED_SAVED_PLACES,
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
   * a refusal applies nothing. Throws when the store cannot be reached.
   */
  merge(
    workosUserId: string,
    patch: PersonPreferencesPatch,
    now: Date,
  ): Promise<MergeResult>;
}

type Doc = Record<string, unknown>;

/** The few collection calls used, so a test can stand a fake in its place. */
export interface PersonsCollectionLike {
  findOne(filter: Doc, options?: { projection?: Doc }): Promise<Doc | null>;
  bulkWrite(
    operations: { updateOne: { filter: Doc; update: Doc } }[],
    options: { ordered: boolean },
  ): Promise<unknown>;
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

function listFrom<T>(raw: unknown, read: (v: unknown) => T | null): T[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(read).filter((v): v is T => v !== null);
}

const personFilter = (workosUserId: string): Doc => ({
  workosUserId,
  isActive: { $ne: false },
});

async function readStored(
  col: PersonsCollectionLike,
  workosUserId: string,
): Promise<StoredPreferences | null> {
  const doc = await col.findOne(personFilter(workosUserId), {
    projection: { activities: 1, savedPlaces: 1 },
  });
  if (!doc) return null;
  return {
    activities: listFrom(doc.activities, activityFromStored),
    savedPlaces: listFrom(doc.savedPlaces, savedPlaceFromStored),
  };
}

/** A push that is a no-op when the item exists or the list is at its bound. */
function pushIfAbsent(
  person: Doc,
  field: "activities" | "savedPlaces",
  idField: string,
  id: string,
  entry: Doc,
  bound: number,
  now: Date,
) {
  return {
    updateOne: {
      filter: {
        ...person,
        [`${field}.${idField}`]: { $ne: id },
        $expr: { $lt: [{ $size: { $ifNull: [`$${field}`, []] } }, bound] },
      },
      update: { $push: { [field]: entry }, $set: { updatedAt: now } },
    },
  };
}

/** An overwrite that is a no-op unless the stored item is strictly older. */
function setIfLater(
  person: Doc,
  field: "activities" | "savedPlaces",
  idField: string,
  id: string,
  updatedAt: Date,
  set: Doc,
  unset: Doc | null,
  now: Date,
) {
  return {
    updateOne: {
      filter: {
        ...person,
        [field]: {
          $elemMatch: { [idField]: id, updatedAt: { $lt: updatedAt } },
        },
      },
      update: {
        $set: { ...set, [`${field}.$.updatedAt`]: updatedAt, updatedAt: now },
        ...(unset ? { $unset: unset } : {}),
      },
    },
  };
}

function operations(
  workosUserId: string,
  patch: PersonPreferencesPatch,
  now: Date,
  purge: boolean,
) {
  const person = personFilter(workosUserId);
  const cutoff = new Date(now.getTime() - TOMBSTONE_RETENTION_MS);
  const old = { tombstone: true, updatedAt: { $lt: cutoff } };
  const ops: { updateOne: { filter: Doc; update: Doc } }[] = [];
  // Tombstones past their 30 days go first, so they do not count. Only asked
  // when the read just made saw one.
  if (purge) {
    ops.push({
      updateOne: {
        filter: person,
        update: { $pull: { activities: old, savedPlaces: old } },
      },
    });
  }
  for (const a of patch.activities) {
    const updatedAt = new Date(a.updatedAt);
    const entry = {
      activityId: a.activityId,
      createdAt: new Date(a.createdAt),
      updatedAt,
      tombstone: a.tombstone,
    };
    ops.push(
      pushIfAbsent(
        person,
        "activities",
        "activityId",
        a.activityId,
        entry,
        MAX_STORED_ACTIVITIES,
        now,
      ),
      setIfLater(
        person,
        "activities",
        "activityId",
        a.activityId,
        updatedAt,
        { "activities.$.tombstone": a.tombstone },
        null,
        now,
      ),
    );
  }
  for (const p of patch.savedPlaces) {
    const updatedAt = new Date(p.updatedAt);
    const entry: Doc = {
      savedPlaceId: p.savedPlaceId,
      createdAt: new Date(p.createdAt),
      updatedAt,
      tombstone: p.tombstone,
      ...(p.envelope ? { envelope: p.envelope } : {}),
    };
    ops.push(
      pushIfAbsent(
        person,
        "savedPlaces",
        "savedPlaceId",
        p.savedPlaceId,
        entry,
        MAX_STORED_SAVED_PLACES,
        now,
      ),
      setIfLater(
        person,
        "savedPlaces",
        "savedPlaceId",
        p.savedPlaceId,
        updatedAt,
        {
          "savedPlaces.$.tombstone": p.tombstone,
          ...(p.envelope ? { "savedPlaces.$.envelope": p.envelope } : {}),
        },
        // A tombstone keeps the common fields and drops the rest.
        p.envelope ? null : { "savedPlaces.$.envelope": "" },
        now,
      ),
    );
  }
  return ops;
}

/** The `identity.persons` implementation. */
export function createIdentityPersonsStore(
  collection: () => PersonsCollectionLike = () =>
    identityDb().collection("persons") as unknown as PersonsCollectionLike,
): PersonPreferencesStore {
  return {
    read: (workosUserId) => readStored(collection(), workosUserId),

    async merge(workosUserId, patch, now) {
      const col = collection();
      const stored = await readStored(col, workosUserId);
      if (!stored) return { kind: "no_person" };

      // Judge the merge against what survives the purge of old tombstones.
      const cutoff = toWireTime(
        new Date(now.getTime() - TOMBSTONE_RETENTION_MS),
      );
      const kept = <T extends { tombstone: boolean; updatedAt: string }>(
        items: T[],
      ) => items.filter((i) => !(i.tombstone && i.updatedAt < cutoff));
      const before = {
        activities: kept(stored.activities),
        savedPlaces: kept(stored.savedPlaces),
      };
      const purge =
        before.activities.length < stored.activities.length ||
        before.savedPlaces.length < stored.savedPlaces.length;
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

      // An empty request writes nothing (not even a purge of old tombstones).
      if (patch.activities.length + patch.savedPlaces.length === 0) {
        return { kind: "ok", stored };
      }
      await col.bulkWrite(operations(workosUserId, patch, now, purge), {
        ordered: true,
      });
      const after = await readStored(col, workosUserId);
      return after ? { kind: "ok", stored: after } : { kind: "no_person" };
    },
  };
}

/** The store the route uses. */
export const personPreferencesStore: PersonPreferencesStore =
  createIdentityPersonsStore();
