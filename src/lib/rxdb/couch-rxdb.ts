/**
 * The RxDB side of the CouchDB sync: one database and one collection per
 * person, and the one-shot replication that runs against their `user_<id>`.
 *
 * WHY A DATABASE OF ITS OWN. `mukoko_weather` (database.ts) is the app's
 * preferences and caches; this one exists only while `FLAGS.couch_sync` is on.
 * A visitor with the flag off never creates it, and one database per person
 * (`mukoko_weather_sync_<personId>`) means a second person signing in on the
 * same device can never push the first person's documents into their own
 * database: they are in another database, with another replication checkpoint.
 *
 * WHY NON-LIVE. The gateway refuses continuous and event-source feeds and
 * drops heartbeats (nyuchi-api `couch_proxy_policy.py`). `live: false` makes
 * the plugin do exactly one pull (`_changes?feed=normal`) and one push
 * (`_all_docs` POST, `_bulk_docs`), then cancel itself. The checkpoint
 * persists under the same `replicationIdentifier`, so the next cycle is
 * incremental. A timer, focus, "online" and a local write start the cycles
 * (`couch-sync.ts`).
 *
 * The plugin retries a failed request on its own, for ever. A cycle must not:
 * the first error cancels it and the failure (with its HTTP status, kept by
 * the fetch layer) goes to the engine, which backs off.
 *
 * Imported dynamically, only after the flag is on and a credential exists, so
 * RxDB's CouchDB plugin is in no page's first-load JavaScript.
 */

import type { RxCollection, RxDatabase, RxJsonSchema, RxStorage } from "rxdb";
import {
  resolveUserDocConflict,
  toPullDoc,
  toPushDoc,
  toRfc3339,
  type UserDocType,
} from "./couch-docs";
import {
  CouchHttpError,
  createCouchFetch,
  type CouchFetch,
} from "./couch-fetch";
import type { CouchSession } from "./couch-session";
import type { SyncStore } from "./couch-sync";

export const SYNC_DB_PREFIX = "mukoko_weather_sync_";
/** A whole cycle (pull, push, retries) may take this long before it is a failure. */
export const CYCLE_TIMEOUT_MS = 60_000;
const PULL_BATCH = 200;
const PUSH_BATCH = 50;

export const userDocsSchema: RxJsonSchema<UserDocType> = {
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 100 },
    type: { type: "string", enum: ["preference", "activity"], maxLength: 16 },
    schemaVersion: { type: "number" },
    ownerPersonId: { type: "string", maxLength: 128 },
    deviceId: { type: "string", maxLength: 64 },
    createdAt: { type: "string", maxLength: 32 },
    updatedAt: { type: "string", maxLength: 32 },
    preferenceKey: { type: "string", maxLength: 32 },
    preferenceValue: { type: "string", maxLength: 64 },
    activityId: { type: "string", maxLength: 64 },
  },
  required: [
    "id",
    "type",
    "schemaVersion",
    "ownerPersonId",
    "deviceId",
    "createdAt",
    "updatedAt",
  ],
};

type UserDocCollection = RxCollection<UserDocType>;
type SyncDatabase = RxDatabase<{ user_docs: UserDocCollection }>;

export interface OpenStoreOptions {
  /** An RxDB storage; the browser default is Dexie (IndexedDB). */
  storage?: RxStorage<unknown, unknown>;
  /** The transport under the authenticated fetch (tests inject one). */
  baseFetch?: typeof fetch;
  cycleTimeoutMs?: number;
  /** How long the plugin waits before retrying a failed request. */
  retryTimeMs?: number;
  /** Database name suffix, so tests never collide. */
  nameSuffix?: string;
}

/** Plain, frozen-free copy of a stored document's fields. */
function plain(doc: UserDocType): UserDocType {
  const out: UserDocType = {
    id: doc.id,
    type: doc.type,
    schemaVersion: doc.schemaVersion,
    ownerPersonId: doc.ownerPersonId,
    deviceId: doc.deviceId,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
  if (doc.preferenceKey !== undefined) out.preferenceKey = doc.preferenceKey;
  if (doc.preferenceValue !== undefined)
    out.preferenceValue = doc.preferenceValue;
  if (doc.activityId !== undefined) out.activityId = doc.activityId;
  return out;
}

/**
 * Open the person's local sync database. Resolves to null (never rejects)
 * when RxDB or the storage is unavailable (private browsing, no IndexedDB):
 * sync is an enhancement and must never break the app.
 */
export async function openUserDocStore(
  personId: string,
  options: OpenStoreOptions = {},
): Promise<SyncStore | null> {
  try {
    const [{ createRxDatabase, defaultConflictHandler }, replication] =
      await Promise.all([
        import("rxdb"),
        import("rxdb/plugins/replication-couchdb"),
      ]);
    let storage = options.storage;
    if (!storage) {
      const dexie = await import("rxdb/plugins/storage-dexie");
      storage = dexie.getRxStorageDexie() as unknown as RxStorage<
        unknown,
        unknown
      >;
    }
    const db = (await createRxDatabase({
      name: `${SYNC_DB_PREFIX}${personId}${options.nameSuffix ?? ""}`,
      storage: storage as RxStorage<never, never>,
      multiInstance: false,
      eventReduce: true,
    })) as unknown as SyncDatabase;

    await db.addCollections({
      user_docs: {
        schema: userDocsSchema,
        conflictHandler: {
          isEqual: defaultConflictHandler.isEqual,
          resolve: async (input) =>
            resolveUserDocConflict(
              input.realMasterState as UserDocType & { _deleted?: boolean },
              input.newDocumentState as UserDocType & { _deleted?: boolean },
            ),
        },
      },
    });
    const col = db.user_docs;

    return {
      async liveDocs() {
        const found = await col.find().exec();
        return found.map((d) => plain(d.toJSON() as unknown as UserDocType));
      },

      async knownIds(ids) {
        if (ids.length === 0) return new Set();
        const found = await col.storageInstance.findDocumentsById(ids, true);
        return new Set(Object.keys(found));
      },

      async upsert(doc) {
        await col.upsert(plain(doc));
      },

      async tombstone(id, nowMs) {
        const existing = await col.findOne(id).exec();
        if (!existing) return;
        // Stamp the deletion first, so a conflict with an edit made elsewhere
        // is ordered by when the person actually deleted it.
        await existing.incrementalPatch({ updatedAt: toRfc3339(nowMs) });
        const latest = await col.findOne(id).exec();
        if (latest) await latest.remove();
      },

      async runReplication(session: CouchSession) {
        let failure: unknown = null;
        const authed = createCouchFetch({
          databaseUrl: session.databaseUrl,
          getToken: () => session.token,
          baseFetch: options.baseFetch,
        });
        const watched: CouchFetch = async (url, init) => {
          try {
            return await authed(url, init);
          } catch (err) {
            failure ??= err;
            throw err;
          }
        };

        const state = replication.replicateCouchDB<UserDocType>({
          replicationIdentifier: `mukoko-couch-${session.database}`,
          collection: col,
          url: session.databaseUrl,
          fetch: watched,
          live: false,
          waitForLeadership: false,
          autoStart: true,
          retryTime: options.retryTimeMs ?? 1_000,
          pull: {
            batchSize: PULL_BATCH,
            modifier: (doc) => toPullDoc(doc as never) as never,
          },
          push: {
            batchSize: PUSH_BATCH,
            modifier: (doc) => toPushDoc(doc as never) as never,
          },
        });

        /**
         * The plugin retries a failed request for ever, and `cancel()` and
         * `pause()` both queue behind the start, which for a non-live
         * replication only ends when the first sync does: a failing request
         * would deadlock the cancel. Flagging the replication as paused
         * through its own state makes the retry loops return at once; the
         * start then finishes and `cancel()` tears everything down.
         */
        const endCycle = (): void => {
          state.internalReplicationState?.events.paused.next(true);
        };

        let timer: ReturnType<typeof setTimeout> | undefined;
        const failed = new Promise<never>((_, reject) => {
          state.error$.subscribe(() => {
            endCycle();
            reject(
              failure instanceof CouchHttpError
                ? failure
                : new CouchHttpError(0),
            );
          });
          timer = setTimeout(() => {
            endCycle();
            reject(new CouchHttpError(0));
          }, options.cycleTimeoutMs ?? CYCLE_TIMEOUT_MS);
        });
        failed.catch(() => undefined); // never an unhandled rejection
        try {
          await Promise.race([state.awaitInitialReplication(), failed]);
        } finally {
          if (timer) clearTimeout(timer);
          await state.cancel().catch(() => undefined);
        }
      },

      async close() {
        await db.close().catch(() => undefined);
      },
    };
  } catch {
    return null;
  }
}
