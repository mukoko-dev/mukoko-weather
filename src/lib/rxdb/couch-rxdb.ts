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
 * the plugin do exactly one pull (`_changes?feed=normal`, sent by the fetch
 * layer as `POST` with `filter=_doc_ids` and this client's ids, so documents of
 * other clients can neither fill nor stall a page) and one push (`_all_docs`
 * POST, `_bulk_docs`), then cancel itself. The checkpoint persists under the
 * same `replicationIdentifier`, so the next cycle is incremental. A timer,
 * focus, "online" and a local write start the cycles (`couch-sync.ts`).
 *
 * The plugin retries a failed request on its own, for ever. A cycle must not:
 * the first error cancels it and the failure (with its HTTP status, kept by
 * the fetch layer) goes to the engine, which backs off. `cancelReplication()`
 * ends a running cycle at once and aborts its requests (the page is going away).
 *
 * ONE TAB REPLICATES. Every tab of the browser opens the same IndexedDB
 * database, so it is opened `multiInstance: true` (tabs hear each other's
 * writes, no stale queries) and the replication waits for leadership, as
 * `replication.ts` does for the app's own preferences. Only the leader tab
 * pulls and pushes; the engine asks `isLeader()` and a follower just applies
 * what the shared database holds (`couch-sync.ts`). `onShared()` tells the
 * engine the shared database changed, so a hidden leader can push what a
 * visible follower wrote.
 *
 * WHOSE IT IS. The database holds one person's settings and activities, so
 * `openUserDocStore` records the person (ids only, `sync-people-index.ts`) and
 * `purgeUserDocStores` removes every recorded database but the signed-in
 * person's: on sign-out (the session route answering `401 signed_out` on two
 * page loads, `couch-sync.ts`) and when a different person is issued. Nothing
 * here runs with the flag off.
 *
 * Imported dynamically, only after the flag is on and a credential exists, so
 * RxDB's CouchDB plugin is in no page's first-load JavaScript.
 */

import type { RxCollection, RxDatabase, RxJsonSchema, RxStorage } from "rxdb";
import {
  assertPlaintextDoc,
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
import {
  forgetSyncPerson,
  recordSyncPerson,
  recordedSyncPeople,
} from "./sync-people-index";

export const SYNC_DB_PREFIX = "mukoko_weather_sync_";
/** A whole cycle (pull, push, retries) may take this long before it is a failure. */
export const CYCLE_TIMEOUT_MS = 60_000;
/**
 * How long the first leadership question waits for the election to settle in a
 * tab that does not win it. After that the answer is read without waiting.
 */
export const LEADER_WAIT_MS = 3_000;
/** Removing a database that another tab still holds open may not finish. */
export const REMOVE_TIMEOUT_MS = 5_000;
/**
 * How long a finished or failed cycle waits for the plugin to wind its
 * replication down (`state.cancel()`). Past it the replication is abandoned.
 */
export const CANCEL_TIMEOUT_MS = 5_000;
/** ...and `db.close()` for a database whose replication cannot be wound down. */
export const CLOSE_TIMEOUT_MS = 5_000;
const PULL_BATCH = 200;
const PUSH_BATCH = 50;

/**
 * THE ONE PLACE this layer reaches into an RxDB internal, and why.
 *
 * The plugin retries a failed request for ever, and `cancel()` and `pause()`
 * both queue behind the replication's start, which for a non-live replication
 * only ends when the first sync does: a request that keeps failing would
 * deadlock the cancel (and, through it, the cycle, the engine's queue, `stop()`
 * and the pagehide). Flagging the replication as paused through its own state
 * makes the retry loops return (`while (!done && !this.isStoppedOrPaused())`);
 * the start then finishes and `cancel()` tears everything down. There is no
 * public API for this: `pause()` is queued behind the same start.
 *
 * It is pinned against the installed RxDB by `couch-rxdb-internals.test.ts`
 * (version, shape and behaviour, with a message saying what to re-check on an
 * upgrade), and a cycle cannot hang on it even if an upgrade breaks it: the wait
 * for `cancel()` is bounded (`CANCEL_TIMEOUT_MS`) and a replication that could
 * not be wound down is abandoned and not followed by another.
 */
export function endReplicationRetries(state: {
  internalReplicationState?: {
    events: { paused: { next(paused: boolean): void } };
  };
}): void {
  state.internalReplicationState?.events.paused.next(true);
}

/** True when `work` settled within `ms`, false when the wait ran out. */
async function settledWithin(work: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const userDocsSchema: RxJsonSchema<UserDocType> = {
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 100 },
    type: { type: "string", enum: ["preference", "activity"], maxLength: 16 },
    // A string such as "v3.1" (the validator's `^v[0-9]+\.[0-9]+$`), not a number.
    schemaVersion: { type: "string", maxLength: 16 },
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
  /** How long the first leadership answer waits for the election (tests shorten it). */
  leaderWaitMs?: number;
  /**
   * How a failed or abandoned cycle's replication is ended: the RxDB internal
   * above by default; a test passes something inert to stand for an upgrade
   * that broke it.
   */
  endCycle?: typeof endReplicationRetries;
  /** How long to wait for the plugin to wind a replication down before abandoning it. */
  cancelTimeoutMs?: number;
  /** ...and for `db.close()`. */
  closeTimeoutMs?: number;
}

/** The name of a person's local sync database. */
function databaseName(personId: string, nameSuffix = ""): string {
  return `${SYNC_DB_PREFIX}${personId}${nameSuffix}`;
}

/** Plain, frozen-free copy of a stored document's fields. */
function plain(doc: UserDocType): UserDocType {
  const out: UserDocType = {
    id: doc.id,
    type: doc.type,
    schemaVersion: doc.schemaVersion,
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
    const [
      { addRxPlugin, createRxDatabase, defaultConflictHandler },
      replication,
      { RxDBLeaderElectionPlugin },
    ] = await Promise.all([
      import("rxdb"),
      import("rxdb/plugins/replication-couchdb"),
      import("rxdb/plugins/leader-election"),
    ]);
    // `isLeader()`, `waitForLeadership()` and the elector come from this plugin
    // (adding it twice is a no-op); the replication adds it only when it starts.
    addRxPlugin(RxDBLeaderElectionPlugin);
    let storage = options.storage;
    if (!storage) {
      const dexie = await import("rxdb/plugins/storage-dexie");
      storage = dexie.getRxStorageDexie() as unknown as RxStorage<
        unknown,
        unknown
      >;
    }
    // Written down BEFORE the database exists, so a database can never be
    // there without a record that lets sign-out find and remove it.
    recordSyncPerson(personId);
    const db = (await createRxDatabase({
      name: databaseName(personId, options.nameSuffix),
      storage: storage as RxStorage<never, never>,
      // Shared by every tab of the browser: the tabs hear each other's writes
      // and elect one leader to replicate.
      multiInstance: true,
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

    // The first answer may have to wait for the election to settle; once it
    // has, the question is read without waiting (a follower is not held up
    // again on every cycle).
    let electionSettled = false;
    /** Ends the replication that is running now; null when none is. */
    let abandonCycle: (() => void) | null = null;
    /**
     * A replication of this database could not be wound down in time and was
     * abandoned: it may still be retrying inside the plugin (it sends nothing:
     * its requests are aborted). A second replication of the same identifier
     * beside it would race it for the checkpoint, so none is started: later
     * cycles fail at once as "no answer" and the engine backs off. The page
     * keeps working on the local database until it is reloaded.
     */
    let stuck = false;
    const endCycleWith = options.endCycle ?? endReplicationRetries;

    return {
      async isLeader() {
        if (db.isLeader()) {
          electionSettled = true;
          return true;
        }
        if (electionSettled) return false;
        electionSettled = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            db.waitForLeadership().then(() => true),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(
                () => resolve(false),
                options.leaderWaitMs ?? LEADER_WAIT_MS,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      },

      onShared(listener) {
        const sub = col.$.subscribe(() => listener());
        return () => sub.unsubscribe();
      },

      async liveDocs() {
        const found = await col.find().exec();
        return found.map((d) => plain(d.toJSON() as unknown as UserDocType));
      },

      async knownIds(ids) {
        if (ids.length === 0) return new Set();
        // RxDB 17 answers with an ARRAY of documents (deleted ones included);
        // reading its keys named positions, so nothing was ever "known" and a
        // device's own values were seeded over the person's other devices'.
        const found = await col.storageInstance.findDocumentsById(ids, true);
        return new Set(found.map((d) => d.id));
      },

      async upsert(doc) {
        // The last gate before a document is stored to be pushed: refuses what
        // the validator would refuse (`assertPlaintextDoc`).
        assertPlaintextDoc(doc);
        await col.upsert(plain(doc));
      },

      async tombstone(id, nowMs, deviceId) {
        const existing = await col.findOne(id).exec();
        if (!existing) return;
        // Stamp the deletion first (when, and by which install), so a conflict
        // with an edit made elsewhere is ordered by when the person actually
        // deleted it, and the tombstone carries the common fields the validator
        // requires of every document, deleted or not.
        await existing.incrementalPatch({
          updatedAt: toRfc3339(nowMs),
          deviceId,
        });
        const latest = await col.findOne(id).exec();
        if (latest) await latest.remove();
      },

      cancelReplication() {
        abandonCycle?.();
      },

      async runReplication(session: CouchSession) {
        if (stuck) throw new CouchHttpError(0);
        let failure: unknown = null;
        const requests = new AbortController();
        const authed = createCouchFetch({
          databaseUrl: session.databaseUrl,
          getToken: () => session.token,
          baseFetch: options.baseFetch,
          signal: requests.signal,
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
          // Only the leader tab replicates (the engine asks `isLeader()`
          // first, so a follower never gets here to wait for ever).
          waitForLeadership: true,
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

        /** Ends the retry loops (see `endReplicationRetries`); never throws. */
        const endCycle = (): void => {
          try {
            endCycleWith(state);
          } catch {
            // The bounded wait below is the safety net.
          }
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
          // The page is going away: end the cycle now, abort what it has in
          // flight, and fail it as "no answer" (the engine ignores the failure
          // of a run that was stopped).
          abandonCycle = () => {
            endCycle();
            requests.abort();
            reject(new CouchHttpError(0));
          };
        });
        failed.catch(() => undefined); // never an unhandled rejection
        try {
          await Promise.race([state.awaitInitialReplication(), failed]);
        } finally {
          if (timer) clearTimeout(timer);
          abandonCycle = null;
          requests.abort(); // nothing of this cycle outlives it
          // Bounded: if the plugin cannot wind down (an RxDB upgrade changed
          // what `endReplicationRetries` stands on), the cycle ends anyway and
          // the replication is abandoned, not waited for for ever.
          const woundDown = await settledWithin(
            state.cancel(),
            options.cancelTimeoutMs ?? CANCEL_TIMEOUT_MS,
          );
          if (!woundDown) stuck = true;
        }
      },

      async close() {
        // Bounded too: closing the database cancels its replications, and one
        // that could not be wound down would hold the close (and `stop()`).
        await settledWithin(
          db.close(),
          options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS,
        );
      },
    };
  } catch {
    return null;
  }
}

export interface RemoveStoreOptions {
  /** An RxDB storage; the browser default is Dexie (IndexedDB). */
  storage?: RxStorage<unknown, unknown>;
  /** Database name suffix, so tests never collide. */
  nameSuffix?: string;
  removeTimeoutMs?: number;
}

/**
 * Delete a person's local sync database (their settings and activities, and the
 * replication checkpoint). Resolves true when it is gone, false when it could
 * not be removed (IndexedDB blocked or missing, another tab holding it open
 * past the timeout). Never rejects. The caller closes its own handle first.
 */
export async function removeUserDocStore(
  personId: string,
  options: RemoveStoreOptions = {},
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { removeRxDatabase } = await import("rxdb");
    let storage = options.storage;
    if (!storage) {
      const dexie = await import("rxdb/plugins/storage-dexie");
      storage = dexie.getRxStorageDexie() as unknown as RxStorage<
        unknown,
        unknown
      >;
    }
    await Promise.race([
      removeRxDatabase(
        databaseName(personId, options.nameSuffix),
        storage as RxStorage<never, never>,
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("remove timed out")),
          options.removeTimeoutMs ?? REMOVE_TIMEOUT_MS,
        );
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Remove the local sync database of every recorded person except `keep` (of
 * everyone when `keep` is null), and forget each one that is gone. A database
 * that cannot be removed stays recorded, so the next run tries again. Never
 * rejects; with nothing recorded it touches nothing, not even IndexedDB.
 */
export async function purgeUserDocStores(
  keep: string | null,
  options: RemoveStoreOptions = {},
): Promise<void> {
  try {
    for (const personId of recordedSyncPeople()) {
      if (personId === keep) continue;
      if (await removeUserDocStore(personId, options)) {
        forgetSyncPerson(personId);
      }
    }
  } catch {
    // Best effort: the sign-out never fails because of a local cleanup.
  }
}
