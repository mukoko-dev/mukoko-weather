/**
 * The CouchDB sync engine (mukoko-dev/mukoko-weather#396, web slice).
 *
 * ORCHESTRATION ONLY. Everything it touches is injected: the RxDB layer
 * (`SyncStore`), the app's state (`SyncBridge`), the credential source, the
 * clock and the timers. That is what makes the rules below testable without a
 * database, a browser or a server. The real wiring is `couch-sync-start.ts`;
 * the RxDB layer is `couch-rxdb.ts`.
 *
 * AT START, before anything else and with no network: the local database of
 * the person this browser already holds one for is opened (`recordedPerson`),
 * and the changes made since are written to it. The local database is purely
 * on-device, so none of this needs a credential or a connection; it is what
 * makes a change made offline durable the moment its 750 ms debounce ends.
 *
 * ONE CYCLE (serialised: at most one runs, at most one more waits):
 *
 *   0. leader?      a tab that is not the leader stops here: it asks for no
 *                   credential, writes the person's changes into the shared
 *                   database and applies what is in it
 *   1. credential   reuse the token while it has more than a minute left,
 *                   else ask the route for a new one (the gateway's sync
 *                   grant: five minutes at most, so about every four)
 *      prepare      once per person per run (and after a 404): ask the gateway
 *                   to make sure the person's database exists
 *   2. local writes the changes the person made since the last write become
 *                   documents (offline too: they wait in the local database)
 *   3. replicate    one non-live pull + push against the person's database
 *                   (the gateway refuses continuous feeds, so there is no
 *                   live stream: a timer, focus, "online" and a local write
 *                   each start a cycle)
 *   4. reconcile    a change made during the replication is written first;
 *                   then, first cycle only, seed documents for settings that
 *                   predate sync AND have no document yet (from the state
 *                   already written, never from a fresh read that would
 *                   include an unwritten change); then apply what the
 *                   documents say to the app. A second replication pushes
 *                   whatever was written after the first
 *
 * DEFAULTS NEVER WIN. A device that has not changed a setting writes nothing
 * for it, and seeding only fills ids that have no document at all, so a fresh
 * device with default settings cannot overwrite what the person set elsewhere.
 * A setting the person DID change is written whenever the local database
 * opens, stamped with when they changed it (the baseline is taken at start(),
 * not when the database opens), so "the later updatedAt wins" holds for a
 * change made while the page was offline, hidden or backing off.
 *
 * A CHANGE IS NEVER ONLY IN MEMORY. The moment the person changes a synced
 * setting the engine records, synchronously, the state they started from and
 * when (`ChangeJournal`, kept in web storage by `sync-pending.ts`); the record
 * is cleared once the change is in a document of a database a credential has
 * said is the person's. The database opened at start is only a guess (the one
 * person this browser holds one for), so a write to it is NOT durable yet: the
 * time of the change and the record stay until a credential confirms it, and a
 * wrong guess loses neither (`settleRecord`). A page that closes inside the
 * debounce, or before any local database exists (a person's first session), or
 * while the credential keeps failing, leaves the record behind, and the next
 * page's engine starts its comparison from it instead of from the state it
 * finds, so the change is still a change: written, stamped with when it was
 * made, and ordered against the server's value by time. Without it the next
 * page saw no difference, pulled the older server value and reverted the
 * person's choice. `stop()` (pagehide) and `flush()` (the page was hidden)
 * also write at once. What the engine applies from the server is not a change
 * of the person's and is never recorded; nor is a value the app's own
 * preferences store applied (`ChangeOrigin` "applied": the hydration, a
 * `/v1/devices` pull, another tab), which becomes the baseline instead
 * (`adoptApplied`). Only a difference in VALUE is a change at all.
 *
 * ONE TAB REPLICATES. The local database is shared by every tab of the browser
 * (RxDB multi-instance) and only the leader tab replicates (`SyncStore.isLeader`),
 * so two tabs never push the same documents or write one checkpoint twice. A
 * follower writes the person's own changes into the shared database and
 * applies what is in it, and asks for no credential of its own: leadership is
 * asked BEFORE the credential, which is possible because the database is
 * already open (a browser with no database yet, a person's first session, has
 * each tab ask once before it can know). A hidden leader does not poll, but it
 * replicates when another tab wrote into the shared database, so a visible
 * follower's change is never stranded.
 *
 * SIGNED OUT IS NOT A FAILURE, AND NOTHING IS WIPED ON A DOUBT. A 401 from the
 * credential route that carries `SIGNED_OUT_CODE` means nobody is signed in:
 * the engine goes idle until the next page load. No failure count, no timer, no
 * retry, no second request, whatever the page does. The FIRST such answer only
 * closes the local database and leaves a mark (one time, `SignedOutMarker`):
 * removing the previous person's local database and the record of unwritten
 * changes cannot be undone, and one answer is an inference (AuthKit can lose a
 * session for a reason that is not a sign-out). The SECOND, on a later page
 * load at least `SIGNED_OUT_CONFIRM_MS` after the first, removes them
 * (`purgeStores`); any session that is issued removes the mark. A different
 * person issued later gets a database of their own and the previous person's is
 * removed at once: a signed credential names them, which is certain. A 401
 * WITHOUT the code, and every other status, is an ordinary failure: the local
 * database may hold the only copy of a change made offline. Likewise an activity
 * is dropped on a remote removal only when its tombstone is in a database a
 * credential has said is the person's, never because a document is missing.
 *
 * THE CREDENTIAL'S LIFE IS COUNTED HERE. The route sends a duration, not a time
 * of day; the engine ends the credential that long after it SENT the request,
 * on its own clock (`fetchFresh`). The server's clock is never compared with
 * this device's.
 *
 * A SCHEDULED DELETION IS TERMINAL, AND TAKES NOTHING. `403
 * account_pending_deletion` from the route does not pass by itself, so the
 * engine stops asking for the rest of the page's life (no timer, no further
 * request; `failureAction` "stop_keep_data"), but it removes nothing: the person
 * is signed in and the deletion can be cancelled. Their changes keep being
 * written to the local database.
 *
 * FAILURES ARE SILENT AND BOUNDED. No console output, never a throw into a
 * render. 401 from the database = the credential was refused: fetch a new one
 * once, then back off. 403, 404, 429, 5xx, offline and timeouts back off 30 s,
 * doubling to 15 min (`couch-schedule.ts`). EVERY trigger respects the back-off:
 * a local write, another tab's write, the poll, a focus and the credential's
 * renewal all wait for the back-off timer while it runs (only the browser's own
 * "online" event ends it early), so a failing service is asked once per wait,
 * not once per edit. A credential with under `COUCH_MIN_GRANT_LIFE_MS` left is
 * a failure too, and two credential fetches are never closer than
 * `REFRESH_MIN_DELAY_MS`, so a short-lived grant cannot make a loop. Nothing
 * waits for ever (a credential request, opening the local database, a
 * replication each have a deadline).
 *
 * STOP IS FAST, AND THE PENDING CHANGE GOES FIRST. `stop()` (pagehide, a
 * restart) signals first: the waits the cycle is in end now (they race against
 * a promise stop() rejects), the replication is abandoned, and every later step
 * of the cycle asks whether the page has said stop before it runs. The pending
 * change is written next, through a lock of its own that the cycle's long waits
 * are not inside (so a replication of a minute does not delay it; the write
 * debounce and `flush()` take the same path); then the chain is awaited, the
 * database closed, the timers cleared and the token dropped from memory. A
 * cycle belongs to the run it began in (`epoch`): after a stop and a start (a
 * page restored from the back/forward cache) the old cycle ends at its next
 * step instead of running beside the new one.
 */

import {
  patchFromDocs,
  planChangeOps,
  planSeedOps,
  type DocContext,
  type LocalDocOp,
  type SyncableState,
  type SyncedPatch,
  type UserDocType,
  activityDocId,
  isDeviceId,
  isKnownActivityId,
  isSyncableActivityId,
  preferenceDocId,
} from "./couch-docs";
import {
  FOCUS_COOLDOWN_MS,
  LOCAL_WRITE_DEBOUNCE_MS,
  POLL_INTERVAL_MS,
  PUSH_DEBOUNCE_MS,
  REFRESH_LEAD_MS,
  backoffDelayMs,
  failureAction,
  isTokenUsable,
  renewalDelayMs,
} from "./couch-schedule";
import { CouchHttpError } from "./couch-fetch";
import { CouchSessionError, type CouchSession } from "./couch-session";
import { COUCH_MIN_GRANT_LIFE_MS } from "../couch-session-timing";
import { cloneSyncableState, sameSyncableState } from "./sync-state";

/** Events from the store this soon after the engine's own write are its own. */
const SELF_WRITE_GRACE_MS = 500;
/**
 * Opening the local database may not take longer than this. IndexedDB can
 * block an open for ever (another tab holding an old version through an
 * upgrade); a cycle waiting on it would freeze the whole engine, and every
 * later cycle with it.
 */
export const OPEN_STORE_TIMEOUT_MS = 10_000;

/**
 * A credential as the engine holds it: what the route sent plus WHEN IT ENDS ON
 * THIS DEVICE'S CLOCK (the moment the request was sent plus the lifetime the
 * server named). The server's clock is never compared with this one.
 */
type Held = CouchSession & { expiresAtMs: number };

/** Thrown inside a cycle that the page has since stopped (or restarted past). */
class Halt extends Error {
  constructor() {
    super("couch-sync: halted");
    this.name = "Halt";
  }
}

// ---------------------------------------------------------------------------
// What the engine is given
// ---------------------------------------------------------------------------

/** The local database for one person, as the engine needs it. */
export interface SyncStore {
  /**
   * Whether this tab may replicate: only the leader tab does (RxDB leader
   * election), so two tabs never push the same documents or write the same
   * checkpoint. Resolves once the election has settled. Optional: a store that
   * is never shared between tabs is always the leader.
   */
  isLeader?(): Promise<boolean>;
  /**
   * Called when the shared database changed. The engine tells its own writes
   * from another tab's; the other tab's wake a hidden leader (to push them) and
   * a visible follower (to apply them). Returns an unsubscribe.
   */
  onShared?(listener: () => void): () => void;
  liveDocs(): Promise<UserDocType[]>;
  /** Ids (of the given ones) that have a document, deleted or not. */
  knownIds(ids: string[]): Promise<Set<string>>;
  upsert(doc: UserDocType): Promise<void>;
  /**
   * Delete a document. The tombstone carries the common fields the validator
   * requires of every document: `nowMs` stamps the deletion (so a conflict with
   * an edit made elsewhere is ordered by when the person deleted it) and
   * `deviceId` is the install that deleted it.
   */
  tombstone(id: string, nowMs: number, deviceId: string): Promise<void>;
  /** One non-live pull + push. Rejects with a `CouchHttpError` on failure. */
  runReplication(session: CouchSession): Promise<void>;
  /**
   * Abandon the replication that is running, if any: its `runReplication`
   * rejects at once and its requests are aborted. Called when the page is going
   * away, so that stopping does not wait out a replication that can last a
   * minute. Optional.
   */
  cancelReplication?(): void;
  close(): Promise<void>;
}

/**
 * Where a change of the app's synced settings came from. `"person"` is an edit
 * made here (and the default when the bridge does not say). `"applied"` is a
 * value that arrived from the app's own preferences store (the hydration, a
 * `/v1/devices` pull, another tab): the person did not make it HERE, so it is
 * never written to the cloud as their edit, with a new time.
 */
export type ChangeOrigin = "person" | "applied";

/** The app's state: read it, hear about changes, apply a remote patch. */
export interface SyncBridge {
  read(): SyncableState;
  /**
   * The listener hears about a change in the VALUE of a synced setting (not a
   * fresh array of the same members) and where it came from.
   */
  subscribe(listener: (origin?: ChangeOrigin) => void): () => void;
  apply(patch: SyncedPatch): void;
}

/**
 * The first "nobody is signed in" answer, remembered across page loads (one
 * time, nothing else): see `sync-signed-out.ts`. Synchronous; may throw
 * (blocked storage), which the engine treats as "no mark".
 */
export interface SignedOutMarker {
  read(): number | null;
  write(atMs: number): void;
  clear(): void;
}

/**
 * How long after the first "nobody is signed in" answer a later one counts as
 * the second. Within it, the same blip (a reload, two tabs racing for one
 * refresh token) is still one observation.
 */
export const SIGNED_OUT_CONFIRM_MS = 60_000;

/**
 * What was true before the person's changes that are not written to documents
 * yet (`base`), and when they last made one (`at`). Kept outside the engine,
 * in the browser's web storage, so a change is never only in memory: a page
 * that closes with a change unwritten (the debounce has not ended, the local
 * database never opened) leaves this behind, and the next page's engine
 * starts its comparison from `base` instead of from the state it finds.
 */
export interface JournalRecord {
  base: SyncableState;
  at: number;
}

/** Synchronous, because it must complete on a page that is going away. */
export interface ChangeJournal {
  /** The record, or null; a corrupt one is null. May throw (blocked storage). */
  read(): JournalRecord | null;
  write(record: JournalRecord): void;
  clear(): void;
}

export type TimerHandle = unknown;

export type Trigger = "focus" | "online";

export interface EngineDeps {
  /** Ask the same-origin route for a credential. */
  fetchSession(): Promise<CouchSession>;
  /**
   * Make sure the person's database exists on the server (the gateway's
   * replication route never creates one). Called once per person per run,
   * before the first replication, and again after a 404 from the database.
   * Rejects with a `CouchHttpError`, which the engine backs off on. Optional:
   * without it the engine assumes the database is there.
   */
  ensureDatabase?(session: CouchSession): Promise<void>;
  /**
   * Remove the local sync database of every person except `keep` (of everyone
   * when `keep` is null), and the record that it exists. The local database
   * holds one person's activities and settings, so it must not outlive their
   * sign-in on this browser or be there for the next person. Called when the
   * route says nobody is signed in (401), and once per run for the person who
   * is. Must not throw; the engine ignores a failure either way. Optional.
   */
  purgeStores?(keep: string | null): Promise<void>;
  /**
   * The person whose local database this browser already holds, when it holds
   * exactly one (the record `purgeStores` keeps), else null. With it the
   * engine opens that database at start(), before any credential and with no
   * network, so the person's changes are written to it at once, offline too,
   * and a tab can tell whether it is the leader before it asks for anything.
   * Optional: without it the database opens when the first credential arrives.
   */
  recordedPerson?(): string | null;
  /** Where changes not yet written to documents are kept. Optional. */
  journal?: ChangeJournal;
  /**
   * Where the first "nobody is signed in" answer is remembered. Without it
   * nothing is ever removed on a 401: removing a person's local copy needs the
   * answer twice, on two page loads, and there is nowhere to remember the first.
   */
  signedOutMarker?: SignedOutMarker;
  /** Open the local database of one person; null when RxDB is unavailable. */
  openStore(personId: string): Promise<SyncStore | null>;
  bridge: SyncBridge;
  /**
   * The install id written into every document (`deviceId`). The validator
   * accepts a lower-case UUID and nothing else; an engine given anything else
   * does not start (status "unavailable"), because every write would be refused
   * and the refusals would hold up the rest of what is pushed.
   */
  deviceId: string;
  now(): number;
  setTimer(fn: () => void, ms: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
  random?: () => number;
  isVisible?: () => boolean;
  isOnline?: () => boolean;
  /** Page events that should start a cycle; returns an unsubscribe. */
  onTrigger?: (listener: (kind: Trigger) => void) => () => void;
}

export type EngineStatus =
  | "stopped"
  | "idle"
  | "syncing"
  | "signed_out"
  | "account_closing"
  | "backing_off"
  | "unavailable";

export interface CouchSyncEngine {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Ask for a cycle soon; coalesced with any already waiting. */
  requestSync(): void;
  /**
   * Write the person's pending changes to the local database now, without
   * waiting for the debounce (the page was hidden or is going away). Resolves
   * when the write has ended. Never rejects.
   */
  flush(): Promise<void>;
  status(): EngineStatus;
  /** Resolves when no cycle or write is running or queued (tests, shutdown). */
  idle(): Promise<void>;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

const sameState = sameSyncableState;
const cloneState = cloneSyncableState;

function candidateIds(state: SyncableState): string[] {
  return [
    preferenceDocId("theme"),
    preferenceDocId("forecastModel"),
    ...state.selectedActivities.filter(isSyncableActivityId).map(activityDocId),
  ];
}

export function createCouchSyncEngine(deps: EngineDeps): CouchSyncEngine {
  const random = deps.random ?? Math.random;
  const isVisible = deps.isVisible ?? (() => true);
  const isOnline = deps.isOnline ?? (() => true);

  let stopped = true;
  /** RxDB cannot be opened here; nothing will change that this session. */
  let unavailable = false;
  /** The route said nobody is signed in: idle until the next page load. */
  let signedOut = false;
  /**
   * The route said the account is scheduled for deletion: idle until the next
   * page load too, but nothing is removed and the person's changes are still
   * written to the local database.
   */
  let accountClosing = false;
  let status: EngineStatus = "stopped";
  let session: Held | null = null;
  let store: SyncStore | null = null;
  let storePerson: string | null = null;
  let seededPerson: string | null = null;
  /** The person whose server-side database `ensureDatabase` has prepared. */
  let ensuredPerson: string | null = null;
  /** The person for whom the other people's local databases were removed. */
  let purgedFor: string | null = null;
  /**
   * The state last written to documents or reconciled with them. Taken at
   * start() (from the journal when the last page left changes unwritten), so a
   * change made before the local database opens (offline, hidden, backing off)
   * is still a change when it does.
   */
  let lastWritten: SyncableState | null = null;
  /** `lastWritten` as start() found it, for a database opened on a guess. */
  let startBaseline: SyncableState | null = null;
  /** When the person last changed a synced setting that is not written yet. */
  let changedAt: number | null = null;
  /** This engine wrote (or adopted) the journal record, so it may clear it. */
  let journalOwned = false;
  /** The open database was chosen from the record, not yet from a credential. */
  let tentative = false;
  /** The engine is applying the server's values to the app; not a person's edit. */
  let applyingRemote = false;
  /** This run has already taken the "signed out" mark away (a session was issued). */
  let markerCleared = false;
  let failures = 0;
  let refetchedThisRun = false;
  let lastRunAt = Number.NEGATIVE_INFINITY;
  /** The engine is writing to the store itself; its events are not another tab's. */
  let selfWriting = 0;
  let selfWroteAt = Number.NEGATIVE_INFINITY;
  /** A cycle was asked for by another tab's write (it may run while hidden). */
  let wakeRequested = false;

  /**
   * Counts start()s. A cycle belongs to the run it began in: after a stop() and
   * a start() (a page restored from the back/forward cache) the old cycle, if
   * it is still waiting on a request, ends at its next step instead of running
   * beside the new one.
   */
  let epoch = 0;
  /** True once this run's cycle or the page has said stop. */
  const halted = (since: number): boolean =>
    stopped || signedOut || accountClosing || since !== epoch;
  /**
   * Rejects (with `Halt`) when stop() is called. The cycle's long waits (a
   * credential request, opening the database, a replication) race against it,
   * so a request that never answers cannot hold the engine, nor stop() behind
   * it. Replaced by every start().
   */
  let halting = newHalting();
  function newHalting(): { promise: Promise<never>; halt: () => void } {
    let halt: () => void = () => undefined;
    const promise = new Promise<never>((_, reject) => {
      halt = () => reject(new Halt());
    });
    promise.catch(() => undefined);
    return { promise, halt };
  }
  const abortable = <T>(work: Promise<T>): Promise<T> =>
    Promise.race([work, halting.promise]);

  let chain: Promise<void> = Promise.resolve();
  /**
   * The engine's view of what is written (`lastWritten`, `changedAt`, the
   * journal) is read and updated by the cycle AND by flushes that must not wait
   * for the cycle. Those sections run one at a time, here. The cycle's long
   * waits (a credential, a replication) are NOT inside it.
   */
  let stateLock: Promise<unknown> = Promise.resolve();
  /** Work started outside the chain (flushes), so `idle()` can wait for it. */
  const loose = new Set<Promise<unknown>>();
  let cycleWaiting = false;
  let pollTimer: TimerHandle | null = null;
  let backoffTimer: TimerHandle | null = null;
  let refreshTimer: TimerHandle | null = null;
  let writeTimer: TimerHandle | null = null;
  let pushTimer: TimerHandle | null = null;
  let unsubBridge: (() => void) | null = null;
  let unsubTrigger: (() => void) | null = null;
  let unsubShared: (() => void) | null = null;

  const enqueue = (job: () => Promise<void>): void => {
    chain = chain.then(job, job);
  };

  /** Run `job` after every earlier locked section, and before any later one. */
  function locked<T>(job: () => Promise<T>): Promise<T> {
    const run = stateLock.then(job, job);
    stateLock = run.catch(() => undefined);
    return run;
  }

  /** Remember a promise that is not in the chain until it settles. */
  function track<T>(promise: Promise<T>): Promise<T> {
    loose.add(promise);
    const forget = () => void loose.delete(promise);
    promise.then(forget, forget);
    return promise;
  }

  function clear(handle: TimerHandle | null): null {
    if (handle !== null) deps.clearTimer(handle);
    return null;
  }

  function clearAllTimers(): void {
    pollTimer = clear(pollTimer);
    backoffTimer = clear(backoffTimer);
    refreshTimer = clear(refreshTimer);
    writeTimer = clear(writeTimer);
    pushTimer = clear(pushTimer);
  }

  /**
   * What a document is written with: the install and the time. Nothing about
   * the person: the database is theirs (`user_<personId>`) and the validator
   * takes ownership from its name.
   */
  function docContext(nowMs: number): DocContext {
    return { deviceId: deps.deviceId, nowMs };
  }

  /** Run a write to the store, so its change events are known to be ours. */
  async function writing<T>(job: () => Promise<T>): Promise<T> {
    selfWriting += 1;
    try {
      return await job();
    } finally {
      selfWriting -= 1;
      selfWroteAt = deps.now();
    }
  }

  async function applyOps(
    target: SyncStore,
    ops: LocalDocOp[],
    nowMs: number,
  ): Promise<void> {
    if (ops.length === 0) return;
    await writing(async () => {
      for (const op of ops) {
        if (op.kind === "upsert") await target.upsert(op.doc);
        else await target.tombstone(op.id, nowMs, deps.deviceId);
      }
    });
  }

  async function isLeaderOf(db: SyncStore): Promise<boolean> {
    try {
      return db.isLeader ? await db.isLeader() : true;
    } catch {
      return true;
    }
  }

  // -- credential ----------------------------------------------------------

  /**
   * Ask the route for a credential, and refuse one that is not worth having:
   * with under `COUCH_MIN_GRANT_LIFE_MS` left it is due for renewal on arrival
   * and would loop, so it is a failure like any other and backs off.
   */
  async function fetchFresh(): Promise<Held> {
    // The server says how long the credential lives from when it issued it. It
    // ends, here, that long after the request was SENT (the answer was issued
    // at some point between, so this is never later than the truth): by this
    // device's clock alone. A time of day on the server's clock would be wrong
    // by however far the two clocks differ, and the credential is five minutes.
    const sentAt = deps.now();
    const fresh = await abortable(deps.fetchSession());
    const expiresAtMs = sentAt + fresh.expiresInMs;
    // The route knows who is signed in: whatever "nobody" it said before was a
    // blip (even if the credential is then too short to use).
    noteSignedIn();
    if (!(expiresAtMs - deps.now() >= COUCH_MIN_GRANT_LIFE_MS)) {
      throw new CouchSessionError(503, "credential_too_short");
    }
    return { ...fresh, expiresAtMs };
  }

  function dropCredential(): void {
    session = null;
    refreshTimer = clear(refreshTimer);
  }

  function scheduleRefresh(s: Held): void {
    const run = epoch;
    refreshTimer = clear(refreshTimer);
    refreshTimer = deps.setTimer(
      () => {
        refreshTimer = null;
        if (halted(run)) return;
        // A hidden page asks when it is shown again, not on a timer; so does a
        // page in a back-off (the cycle the timer starts asks for what it needs).
        if (!isVisible() || backoffTimer !== null) {
          session = null;
          return;
        }
        enqueue(async () => {
          if (halted(run)) return;
          try {
            const fresh = await fetchFresh();
            // The page was stopped while this was out: the token goes nowhere.
            if (halted(run)) return;
            session = fresh;
            scheduleRefresh(fresh);
          } catch (err) {
            if (halted(run)) return;
            session = null;
            handleFailure(err, run);
          }
        });
      },
      // Never sooner than the minimum, even for a credential already inside
      // the lead window: two fetches are never closer than that.
      renewalDelayMs(s.expiresAtMs, deps.now()),
    );
  }

  async function ensureSession(run: number): Promise<Held> {
    if (
      session &&
      isTokenUsable(session.expiresAtMs, deps.now(), REFRESH_LEAD_MS)
    ) {
      return session;
    }
    session = null;
    const fresh = await fetchFresh();
    // The page was stopped while the request was out: keep nothing, arm nothing.
    if (halted(run)) throw new Halt();
    session = fresh;
    scheduleRefresh(fresh);
    return fresh;
  }

  // -- the local database --------------------------------------------------

  /** Close the open store (and stop listening to it). */
  async function closeStore(): Promise<void> {
    unsubShared?.();
    unsubShared = null;
    const closing = store;
    store = null;
    storePerson = null;
    seededPerson = null;
    ensuredPerson = null;
    if (closing) await closing.close().catch(() => undefined);
  }

  /** Remove the other people's local databases; never throws. */
  async function purge(keep: string | null): Promise<void> {
    if (!deps.purgeStores) return;
    try {
      await abortable(deps.purgeStores(keep));
    } catch {
      // Best effort: a blocked or missing IndexedDB must not reach the page.
    }
  }

  /** The local database of the signed-in person. */
  async function ensureStore(personId: string): Promise<SyncStore | null> {
    if (store && storePerson === personId) return store;
    const opened = await openWithin(personId);
    if (!opened) return null;
    store = opened;
    storePerson = personId;
    unsubShared = opened.onShared?.(onSharedWrite) ?? null;
    return store;
  }

  /**
   * Open the local database, but never wait for ever: past
   * `OPEN_STORE_TIMEOUT_MS` it is a failure like any other (the cycle backs
   * off), and a database that opens after that is closed again, not leaked.
   */
  async function openWithin(personId: string): Promise<SyncStore | null> {
    let abandoned = false;
    let timer: TimerHandle | null = null;
    const opening = deps.openStore(personId).then((opened) => {
      // Nobody is waiting for it any more: do not leave it open.
      if (abandoned && opened) void opened.close().catch(() => undefined);
      return opened;
    });
    opening.catch(() => undefined);
    const timeout = new Promise<never>((_, reject) => {
      timer = deps.setTimer(() => {
        abandoned = true;
        reject(new CouchHttpError(0));
      }, OPEN_STORE_TIMEOUT_MS);
    });
    timeout.catch(() => undefined);
    try {
      return await abortable(Promise.race([opening, timeout]));
    } catch (err) {
      abandoned = true;
      throw err;
    } finally {
      if (timer !== null) deps.clearTimer(timer);
    }
  }

  /**
   * Open the local database before any credential: purely on-device, so it
   * needs no network and the person's changes can be written to it at once.
   * Which person's? The one this browser already holds a database for; a
   * browser with none (a person's first session) opens it with the first
   * credential. A guess, until a credential says who is signed in: if it was
   * the wrong person the cycle closes it and starts that person's own.
   */
  async function openLocal(): Promise<void> {
    const run = epoch;
    if (stopped || signedOut || unavailable || store) return;
    let person: string | null = null;
    try {
      person = deps.recordedPerson?.() ?? null;
    } catch {
      person = null;
    }
    if (!person) return;
    try {
      if (!(await ensureStore(person))) return; // the first cycle decides
      if (halted(run)) return; // stop() closes whatever got opened
      tentative = true;
      await flushLocal();
    } catch {
      // The first cycle opens it again, or backs off.
    }
  }

  // -- the journal ---------------------------------------------------------

  /**
   * Keep the pending changes outside the page: written the moment a change is
   * made (synchronously, so it completes on a page that is closing) and
   * cleared once the changes are in documents. Never throws: if web storage is
   * blocked the change is still written to the local database after the
   * debounce, which is the primary path.
   */
  function recordChange(): void {
    if (!deps.journal || !lastWritten || changedAt === null) return;
    try {
      // The state the record starts from is the last one that is DURABLE for
      // the person: in the database a credential has confirmed is theirs. While
      // the open database is only a guess (`tentative`), what was written to it
      // does not count, so the record keeps the state the page started from.
      deps.journal.write({ base: cloneState(durableBase()), at: changedAt });
      journalOwned = true;
    } catch {
      // Best effort.
    }
  }

  /**
   * The state the person's unwritten changes are measured from: what is in the
   * database that is certainly theirs. `lastWritten` once a credential has
   * named the person; until then, the state this page started from, because the
   * database written to was chosen on a guess (`recordedPerson`).
   */
  function durableBase(): SyncableState {
    return tentative && startBaseline
      ? startBaseline
      : (lastWritten as SyncableState);
  }

  /**
   * After a write (or a read that found nothing to write): the person's
   * changes are settled, and the time and the record of them can go, only when
   * they are durable, i.e. in a database a credential has confirmed. A change
   * written to a guessed database keeps its record and its time, so a wrong
   * guess (another person's database) loses neither: the right database gets
   * the change, stamped with when the person made it, and a page that closes
   * before any credential still finds the record.
   */
  function settleRecord(current: SyncableState): void {
    if (
      tentative &&
      startBaseline &&
      changedAt !== null &&
      !sameState(current, startBaseline)
    ) {
      recordChange();
      return;
    }
    changedAt = null;
    clearRecord();
  }

  function clearRecord(): void {
    // Only the engine that left the record clears it: another tab's pending
    // change is not this tab's to forget.
    if (!deps.journal || !journalOwned) return;
    journalOwned = false;
    try {
      deps.journal.clear();
    } catch {
      // Best effort.
    }
  }

  // -- local writes --------------------------------------------------------

  /**
   * Write the changes made since the last write as documents, stamped with when
   * the person made them. Needs the local database, not a credential: it is
   * also what a tab that is not the leader does.
   */
  const flushLocal = (): Promise<boolean> => locked(flushNow);

  /** The body of a flush; callers hold the state lock. */
  async function flushNow(): Promise<boolean> {
    // The database this flush started on: a flush never writes to another one
    // because the engine moved on to another person while it was waiting.
    const db = store;
    if (!db || !storePerson || !lastWritten) return false;
    const base = lastWritten;
    const next = cloneState(deps.bridge.read());
    if (sameState(next, base)) {
      settleRecord(next);
      return false;
    }
    const at = changedAt ?? deps.now();
    const live = new Map((await db.liveDocs()).map((d) => [d.id, d]));
    const ops = planChangeOps(base, next, live, docContext(at));
    await applyOps(db, ops, at);
    lastWritten = next;
    const after = cloneState(deps.bridge.read());
    if (sameState(after, next)) {
      settleRecord(next);
    } else {
      // The person changed something again while this was being written: that
      // one is pending, from the state just written.
      recordChange();
    }
    return ops.length > 0;
  }

  /**
   * First cycle for a person: fill gaps with settings that predate sync. It
   * seeds from the state already written (`lastWritten`, which the cycle has
   * just brought up to date), never from a fresh read: a fresh read would
   * include a change not yet written and make it look like the starting state,
   * and the server's older value would then replace it.
   */
  const seedOnce = (): Promise<boolean> => locked(seedNow);

  async function seedNow(): Promise<boolean> {
    const db = store;
    const s = session;
    if (!db || !s || !lastWritten || seededPerson === s.personId) return false;
    const state = cloneState(lastWritten);
    const known = await db.knownIds(candidateIds(state));
    const ops = planSeedOps(state, known, docContext(deps.now()));
    await applyOps(db, ops, deps.now());
    seededPerson = s.personId;
    return ops.length > 0;
  }

  /**
   * Apply what the documents say, unless the person changed something
   * meanwhile. Resolves true when it had to write a change of the person's
   * first (so the caller replicates again).
   *
   * An activity the device holds is dropped only when the local database holds
   * its TOMBSTONE, i.e. another device deleted it and the deletion was pulled.
   * "No document" means this device has not seen it yet (a follower tab whose
   * leader has not seeded, a database just created or wiped), not that anyone
   * removed it, and reading it as a removal would erase the person's choices.
   */
  const applyRemote = (): Promise<boolean> => locked(applyNow);

  async function applyNow(): Promise<boolean> {
    const db = store;
    if (!db) return false;
    const wrote = await flushNow();
    const before = cloneState(deps.bridge.read());
    const docs = await db.liveDocs();
    const held = before.selectedActivities
      .filter(isKnownActivityId)
      .map(activityDocId);
    const live = new Set(docs.map((d) => d.id));
    // A removal is read only from a database a credential has said is this
    // person's. A follower tab opens "the one person this browser holds a
    // database for", a guess; after a sign-out and another person's sign-in a
    // tombstone there is the PREVIOUS person's and says nothing about what this
    // person chose. (The leader tab, which has a credential, applies the
    // removal, and the tabs share the app's preferences.)
    const deleted = tentative
      ? new Set<string>()
      : new Set([...(await db.knownIds(held))].filter((id) => !live.has(id)));
    const patch = patchFromDocs(docs, before, deleted);
    if (Object.keys(patch).length === 0) return wrote;
    // A change made while the documents were read wins: the next cycle sees it.
    if (!sameState(before, deps.bridge.read())) return wrote;
    applyingRemote = true;
    try {
      deps.bridge.apply(patch);
    } finally {
      applyingRemote = false;
    }
    lastWritten = cloneState(deps.bridge.read());
    return wrote;
  }

  // -- one cycle -----------------------------------------------------------

  /** A cycle ended well. */
  function settled(): void {
    failures = 0;
    refetchedThisRun = false;
    status = "idle";
    if (!stopped && isVisible()) {
      pollTimer = clear(pollTimer);
      pollTimer = deps.setTimer(() => {
        pollTimer = null;
        requestSync();
      }, POLL_INTERVAL_MS);
    }
  }

  async function replicate(db: SyncStore, s: Held): Promise<void> {
    await writing(() => abortable(db.runReplication(s)));
  }

  /** A tab that is not the leader: apply what the shared database holds. */
  async function followOnly(run: number): Promise<void> {
    dropCredential();
    await applyRemote();
    if (halted(run)) return;
    settled();
  }

  async function cycle(): Promise<void> {
    if (stopped || unavailable || signedOut || accountClosing) return;
    // A cycle that was already queued when a failure started the back-off (an
    // edit made while the failing cycle ran) waits for the back-off timer too.
    // The timer, and the browser's "online" event, clear it before asking.
    if (backoffTimer !== null) return;
    const run = epoch;
    const wake = wakeRequested;
    wakeRequested = false;
    if (!isOnline()) {
      status = "backing_off"; // resumes on the "online" event
      return;
    }
    if (!isVisible()) {
      // A hidden page waits for focus, except a hidden LEADER woken by another
      // tab's write: that one pushes it, or the visible tab's change is stranded.
      const leading = wake && store ? await isLeaderOf(store) : false;
      if (!leading) {
        status = "idle"; // resumes on focus / visibility
        return;
      }
    }
    status = "syncing";
    lastRunAt = deps.now();
    try {
      // A tab that is not the leader asks for no credential of its own.
      if (store && !(await isLeaderOf(store))) {
        if (halted(run)) return;
        await followOnly(run);
        return;
      }
      if (halted(run)) return;
      const s = await ensureSession(run);
      if (halted(run)) return;
      if (store && storePerson !== s.personId) {
        // A different person is signed in: the previous person's database
        // closes (and is removed below). If it was opened on a guess from the
        // record, what the person changed since this page started is still
        // theirs to write, to their own database; otherwise the baseline
        // starts again.
        await locked(async () => {
          const guessed = tentative && startBaseline;
          await closeStore();
          lastWritten = guessed
            ? cloneState(startBaseline as SyncableState)
            : cloneState(deps.bridge.read());
        });
        if (halted(run)) return;
      }
      if (purgedFor !== s.personId) {
        await purge(s.personId);
        if (halted(run)) return;
        purgedFor = s.personId;
      }
      const db = await ensureStore(s.personId);
      if (halted(run)) return;
      if (!db) {
        // No local database, so nothing to sync and no use for a credential.
        unavailable = true;
        dropCredential();
        status = "unavailable";
        return;
      }
      // A credential has said whose database this is, so what is written to it
      // from here on is durable (and the next flush settles what was written
      // while it was only a guess: `settleRecord`).
      tentative = false;
      if (!(await isLeaderOf(db))) {
        if (halted(run)) return;
        await followOnly(run);
        return;
      }
      if (halted(run)) return;
      if (deps.ensureDatabase && ensuredPerson !== s.personId) {
        await abortable(deps.ensureDatabase(s));
        if (halted(run)) return;
        ensuredPerson = s.personId;
      }
      await flushLocal();
      if (halted(run)) return;
      try {
        await replicate(db, s);
      } catch (err) {
        // The pull comes before the push. A push that keeps failing (a document
        // the server refuses, a connection that drops half way) must not keep
        // everything the pull stored off this device: apply it, then let the
        // failure back the cycle off as usual.
        if (!(err instanceof Halt) && !halted(run)) {
          await applyRemote().catch(() => false);
        }
        throw err;
      }
      // From here on each step first asks whether the page has said stop: a
      // cycle that finishes a replication after pagehide does not seed, apply
      // or replicate again.
      if (halted(run)) return;
      // A change made while that ran is written before anything is seeded or
      // applied, and pushed by the replication below.
      const flushed = await flushLocal();
      if (halted(run)) return;
      const seeded = await seedOnce();
      if (halted(run)) return;
      const wrote = await applyRemote();
      if (halted(run)) return;
      if (seeded || flushed || wrote) {
        await replicate(db, s);
        if (halted(run)) return;
      }
      settled();
    } catch (err) {
      if (err instanceof Halt) return;
      handleFailure(err, run);
    }
  }

  /**
   * Has "nobody is signed in" now been heard twice, on two page loads? The
   * first time it is written down (the time) and nothing is removed: one answer
   * is an inference, and what it would remove cannot be got back. The second
   * time counts when it is at least `SIGNED_OUT_CONFIRM_MS` after the first
   * (a reload or a second tab a moment later is the same observation, and the
   * mark keeps its first time). A mark from the future (a clock that moved
   * back) is not a first sight; it is made again from now. With nowhere to keep
   * the mark there is no second sight: nothing is ever removed.
   */
  function signedOutHeardTwice(): boolean {
    const marker = deps.signedOutMarker;
    if (!marker) return false;
    let first: number | null = null;
    try {
      first = marker.read();
    } catch {
      first = null;
    }
    const now = deps.now();
    if (first !== null && first <= now) {
      return now - first >= SIGNED_OUT_CONFIRM_MS;
    }
    try {
      marker.write(now);
    } catch {
      // No mark: it will be the first sight again next time.
    }
    return false;
  }

  /** A session was issued: whatever "signed out" was heard before was a blip. */
  function noteSignedIn(): void {
    if (markerCleared) return;
    markerCleared = true;
    try {
      deps.signedOutMarker?.clear();
    } catch {
      // Best effort.
    }
  }

  /**
   * The route said nobody is signed in. Idle until the next page load either
   * way: nothing is counted, nothing is scheduled and nothing asks again.
   *
   * The FIRST time (see `signedOutHeardTwice`) the local database is only
   * closed, and the record of unwritten changes stays: if this was a blip, the
   * next page picks both up where they were. The SECOND time the database held
   * the previous person's settings and is removed, and the record goes too: a
   * change nobody can write for a person who is not signed in is not left for
   * whoever signs in next on this browser.
   */
  function goSignedOut(): void {
    signedOut = true;
    status = "signed_out";
    failures = 0;
    refetchedThisRun = false;
    wakeRequested = false;
    session = null;
    clearAllTimers();
    if (!signedOutHeardTwice()) {
      enqueue(async () => {
        await closeStore();
        purgedFor = null;
      });
      return;
    }
    journalOwned = true;
    clearRecord();
    enqueue(async () => {
      await closeStore();
      purgedFor = null;
      await purge(null);
      try {
        deps.signedOutMarker?.clear();
      } catch {
        // Best effort.
      }
    });
  }

  /**
   * The account is scheduled for deletion. Like a sign-out as far as asking
   * again goes: idle until the next page load, no timer, no further request.
   * Unlike one, nothing is removed (not the local database, not the record of
   * unwritten changes, not the sign-out mark), the store stays open, and the
   * person's changes are still written to it.
   */
  function goAccountClosing(): void {
    accountClosing = true;
    status = "account_closing";
    failures = 0;
    refetchedThisRun = false;
    wakeRequested = false;
    session = null;
    cycleWaiting = false;
    // The timers that would ask again go; the ones that write locally stay
    // (the debounce of the person's own changes).
    pollTimer = clear(pollTimer);
    backoffTimer = clear(backoffTimer);
    refreshTimer = clear(refreshTimer);
    pushTimer = clear(pushTimer);
  }

  function handleFailure(err: unknown, run: number): void {
    // A failure of a cycle the page has since stopped (a replication that was
    // abandoned, a request that came back late) is nobody's to back off on.
    if (halted(run)) return;
    const fromRoute = err instanceof CouchSessionError;
    const status_ =
      fromRoute || err instanceof CouchHttpError
        ? (err as { status: number }).status
        : undefined;
    const action = failureAction(
      fromRoute ? "route" : "couch",
      status_,
      refetchedThisRun,
      // Only a 401 that SAYS nobody is signed in goes idle and removes the
      // local database; any other answer is a failure to retry.
      err instanceof CouchSessionError ? err.code : undefined,
    );
    // The database is not there (never prepared, or gone): prepare it again
    // on the next cycle, after the back-off.
    if (!fromRoute && status_ === 404) ensuredPerson = null;

    if (action === "stay_idle") {
      goSignedOut();
      return;
    }
    if (action === "stop_keep_data") {
      goAccountClosing();
      return;
    }
    if (action === "refetch_token_once") {
      dropCredential();
      refetchedThisRun = true;
      requestSync();
      return;
    }
    if (status_ === 401 || status_ === 403) {
      // The credential is refused: do not keep the token.
      dropCredential();
    }
    refetchedThisRun = false;
    failures += 1;
    status = "backing_off";
    backoffTimer = clear(backoffTimer);
    backoffTimer = deps.setTimer(
      () => {
        backoffTimer = null;
        requestSync();
      },
      backoffDelayMs(failures, random),
    );
  }

  /**
   * Ask for a cycle. While a back-off runs, NOTHING asks: the work is left
   * pending (a wake stays marked, the local database already holds the edits)
   * and the back-off timer runs it when it ends, so a failing service is asked
   * once per wait, not once per edit, poll or focus. The only things that end a
   * back-off early are the browser's "online" event (`onPageTrigger`, which
   * clears the timer first) and stopping; a successful cycle clears the
   * failure count, and the timer is gone by then.
   */
  function requestSync(wake = false): void {
    if (stopped || signedOut || accountClosing) return;
    if (wake) wakeRequested = true;
    if (backoffTimer !== null) return;
    if (cycleWaiting) return;
    cycleWaiting = true;
    enqueue(async () => {
      cycleWaiting = false;
      await cycle();
    });
  }

  // -- triggers ------------------------------------------------------------

  /** After the person's change was written: push it soon. */
  function schedulePush(): void {
    pushTimer = clear(pushTimer);
    pushTimer = deps.setTimer(() => {
      pushTimer = null;
      requestSync();
    }, PUSH_DEBOUNCE_MS);
  }

  /**
   * A value arrived from the app's own preferences store (the hydration, a
   * `/v1/devices` pull, another tab): not an edit the person made here. It
   * becomes the baseline, so it is neither written to the cloud as their edit
   * (with a new time that could beat a newer value from another device, or, for
   * a pull of a profile with no activities, as the removal of every activity)
   * nor reverted. The documents stay the truth: with a document for a setting,
   * the next apply brings the app back to it. Not while the person has a change
   * of their own that is not written yet: the two cannot be told apart in one
   * diff, so that change keeps its record and its time and the applied value
   * rides along with it.
   */
  async function adoptApplied(): Promise<void> {
    await locked(async () => {
      if (stopped || signedOut || changedAt !== null || !lastWritten) return;
      lastWritten = cloneState(deps.bridge.read());
      if (tentative && startBaseline) startBaseline = cloneState(lastWritten);
    });
  }

  function onLocalChange(origin: ChangeOrigin = "person"): void {
    // What the engine itself applied from the server is not the person's edit.
    if (stopped || signedOut || applyingRemote) return;
    if (origin === "applied") {
      void track(adoptApplied().catch(() => undefined));
      return;
    }
    // Only a real difference is a change: the bridge can notify although the
    // settings are the same (a fresh array of the same activities). With
    // nothing pending, that is no edit: no time, no record, no timer.
    if (
      changedAt === null &&
      lastWritten &&
      sameState(deps.bridge.read(), lastWritten)
    ) {
      return;
    }
    changedAt = deps.now();
    // At once and synchronously, before the debounce: a page that closes in
    // the next 750 ms still leaves the change behind.
    recordChange();
    writeTimer = clear(writeTimer);
    writeTimer = deps.setTimer(() => {
      writeTimer = null;
      // Not in the chain: a replication in progress can last a minute, and the
      // person's change does not wait for it.
      void track(flushAndPush());
    }, LOCAL_WRITE_DEBOUNCE_MS);
  }

  /** Write the pending change now, outside the chain, and push it soon. */
  async function flushAndPush(): Promise<void> {
    if (stopped || signedOut) return;
    try {
      if (await flushLocal()) schedulePush();
    } catch {
      // The record and the next cycle still hold it.
    }
  }

  /**
   * The shared database changed. If the engine did not do it, another tab did:
   * the leader replicates it (even hidden), a visible follower applies it.
   */
  function onSharedWrite(): void {
    if (stopped || signedOut || accountClosing) return;
    if (selfWriting > 0) return;
    if (deps.now() - selfWroteAt < SELF_WRITE_GRACE_MS) return;
    pushTimer = clear(pushTimer);
    pushTimer = deps.setTimer(() => {
      pushTimer = null;
      requestSync(true);
    }, PUSH_DEBOUNCE_MS);
  }

  function onPageTrigger(kind: Trigger): void {
    if (stopped || signedOut) return;
    if (kind === "online") {
      failures = 0;
      backoffTimer = clear(backoffTimer);
      requestSync();
      return;
    }
    if (deps.now() - lastRunAt >= FOCUS_COOLDOWN_MS && backoffTimer === null) {
      requestSync();
    }
  }

  return {
    async start() {
      if (!stopped) return;
      stopped = false;
      epoch += 1;
      halting = newHalting();
      unavailable = false;
      signedOut = false;
      accountClosing = false;
      status = "idle";
      // Every document carries this install's id and the validator accepts a
      // lower-case UUID only: with anything else every write would be refused,
      // and a refused write holds up everything pushed with it. Nothing is
      // opened, written or asked for.
      if (!isDeviceId(deps.deviceId)) {
        unavailable = true;
        status = "unavailable";
        return;
      }
      // The baseline is taken here, not when the local database opens: a
      // setting changed before that is a change to write, not the starting
      // state. A page that left changes unwritten left a record of the state
      // they started from (and of when), and that is the baseline instead.
      let saved: JournalRecord | null = null;
      try {
        saved = deps.journal?.read() ?? null;
      } catch {
        saved = null; // unreadable storage: start from this page's own state
      }
      lastWritten = saved
        ? cloneState(saved.base)
        : cloneState(deps.bridge.read());
      startBaseline = cloneState(lastWritten);
      changedAt = saved ? saved.at : null;
      journalOwned = saved !== null;
      tentative = false;
      applyingRemote = false;
      markerCleared = false;
      unsubBridge = deps.bridge.subscribe(onLocalChange);
      unsubTrigger = deps.onTrigger?.(onPageTrigger) ?? null;
      enqueue(openLocal);
      requestSync();
    },

    async stop() {
      if (stopped) return;
      const run = epoch;
      // Signal first: a cycle in flight ends at its next step (`halted`), and
      // the waits it is in the middle of end now.
      stopped = true;
      halting.halt();
      status = "stopped";
      clearAllTimers();
      unsubBridge?.();
      unsubTrigger?.();
      unsubBridge = null;
      unsubTrigger = null;
      session = null; // the token leaves memory
      cycleWaiting = false;
      wakeRequested = false;
      // A replication can last a minute: abandon it rather than wait it out.
      try {
        store?.cancelReplication?.();
      } catch {
        // Best effort.
      }
      // THEN the pending change, before anything that can take long. It goes
      // through the state lock only, never the chain, so it does not wait for
      // the cycle (a replication, a credential request) that is still running.
      // The record in web storage already holds it, and stays if this fails.
      if (!signedOut) await flushLocal().catch(() => false);
      await chain.catch(() => undefined);
      // A start() since (a page restored from the back/forward cache) owns the
      // state now; this stop has nothing more to tear down.
      if (epoch !== run) return;
      // A change that landed while the cycle was ending.
      if (!signedOut) await flushLocal().catch(() => false);
      await closeStore();
      purgedFor = null;
      lastWritten = null;
      startBaseline = null;
      changedAt = null;
      tentative = false;
      failures = 0;
      refetchedThisRun = false;
    },

    async flush() {
      if (stopped || signedOut) return;
      writeTimer = clear(writeTimer);
      await track(flushAndPush());
    },

    requestSync: () => requestSync(),
    status: () => status,
    async idle() {
      for (;;) {
        const seen = chain;
        const pending = [...loose];
        await seen;
        await Promise.allSettled(pending);
        if (seen === chain && loose.size === 0) return;
      }
    },
  };
}
