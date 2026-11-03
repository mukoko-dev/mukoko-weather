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
 * is cleared once the change is in a document. A page that closes inside the
 * debounce, or before any local database exists (a person's first session), or
 * while the credential keeps failing, leaves the record behind, and the next
 * page's engine starts its comparison from it instead of from the state it
 * finds, so the change is still a change: written, stamped with when it was
 * made, and ordered against the server's value by time. Without it the next
 * page saw no difference, pulled the older server value and reverted the
 * person's choice. `stop()` (pagehide) and `flush()` (the page was hidden)
 * also write at once. What the engine applies from the server is not a change
 * of the person's and is never recorded.
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
 * SIGNED OUT IS NOT A FAILURE. 401 from the credential route means nobody is
 * signed in: the engine goes idle until the next page load. No failure count,
 * no timer, no retry, no second request, whatever the page does. It closes and
 * removes the local sync database (`purgeStores`), which held the previous
 * person's settings; a different person issued later gets a database of their
 * own and the previous person's is removed.
 *
 * FAILURES ARE SILENT AND BOUNDED. No console output, never a throw into a
 * render. 401 from the database = the credential was refused: fetch a new one
 * once, then back off. 403, 404, 429, 5xx, offline and timeouts back off 30 s,
 * doubling to 15 min (`couch-schedule.ts`). A credential with under
 * `COUCH_MIN_GRANT_LIFE_MS` left is a failure too, and two credential fetches
 * are never closer than `REFRESH_MIN_DELAY_MS`, so a short-lived grant cannot
 * make a loop. `stop()` (tab close, a restart) cancels every timer and drops
 * the token from memory.
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

/** Events from the store this soon after the engine's own write are its own. */
const SELF_WRITE_GRACE_MS = 500;

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
  /** Delete a document; `nowMs` stamps the deletion so conflicts can be ordered. */
  tombstone(id: string, nowMs: number): Promise<void>;
  /** One non-live pull + push. Rejects with a `CouchHttpError` on failure. */
  runReplication(session: CouchSession): Promise<void>;
  close(): Promise<void>;
}

/** The app's state: read it, hear about changes, apply a remote patch. */
export interface SyncBridge {
  read(): SyncableState;
  subscribe(listener: () => void): () => void;
  apply(patch: SyncedPatch): void;
}

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
  /** Open the local database of one person; null when RxDB is unavailable. */
  openStore(personId: string): Promise<SyncStore | null>;
  bridge: SyncBridge;
  /** The install id written into every document (`deviceId`). */
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

function sameState(a: SyncableState, b: SyncableState): boolean {
  return (
    a.theme === b.theme &&
    a.selectedForecastModel === b.selectedForecastModel &&
    a.selectedActivities.length === b.selectedActivities.length &&
    a.selectedActivities.every((id, i) => id === b.selectedActivities[i])
  );
}

function cloneState(s: SyncableState): SyncableState {
  return { ...s, selectedActivities: [...s.selectedActivities] };
}

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
  let status: EngineStatus = "stopped";
  let session: CouchSession | null = null;
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
  let failures = 0;
  let refetchedThisRun = false;
  let lastRunAt = Number.NEGATIVE_INFINITY;
  /** The engine is writing to the store itself; its events are not another tab's. */
  let selfWriting = 0;
  let selfWroteAt = Number.NEGATIVE_INFINITY;
  /** A cycle was asked for by another tab's write (it may run while hidden). */
  let wakeRequested = false;

  let chain: Promise<void> = Promise.resolve();
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

  function docContext(nowMs: number): DocContext {
    const personId = storePerson ?? session?.personId;
    if (!personId) throw new Error("couch-sync: no person");
    return { personId, deviceId: deps.deviceId, nowMs };
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

  async function applyOps(ops: LocalDocOp[], nowMs: number): Promise<void> {
    if (!store || ops.length === 0) return;
    const target = store;
    await writing(async () => {
      for (const op of ops) {
        if (op.kind === "upsert") await target.upsert(op.doc);
        else await target.tombstone(op.id, nowMs);
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
  async function fetchFresh(): Promise<CouchSession> {
    const fresh = await deps.fetchSession();
    if (!(fresh.expiresAtMs - deps.now() >= COUCH_MIN_GRANT_LIFE_MS)) {
      throw new CouchSessionError(503, "credential_too_short");
    }
    return fresh;
  }

  function dropCredential(): void {
    session = null;
    refreshTimer = clear(refreshTimer);
  }

  function scheduleRefresh(s: CouchSession): void {
    refreshTimer = clear(refreshTimer);
    refreshTimer = deps.setTimer(
      () => {
        refreshTimer = null;
        if (stopped || signedOut) return;
        // A hidden page asks when it is shown again, not on a timer.
        if (!isVisible()) {
          session = null;
          return;
        }
        enqueue(async () => {
          if (stopped || signedOut) return;
          try {
            session = await fetchFresh();
            scheduleRefresh(session);
          } catch (err) {
            session = null;
            handleFailure(err);
          }
        });
      },
      // Never sooner than the minimum, even for a credential already inside
      // the lead window: two fetches are never closer than that.
      renewalDelayMs(s.expiresAtMs, deps.now()),
    );
  }

  async function ensureSession(): Promise<CouchSession> {
    if (
      session &&
      isTokenUsable(session.expiresAtMs, deps.now(), REFRESH_LEAD_MS)
    ) {
      return session;
    }
    session = null;
    const fresh = await fetchFresh();
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
      await deps.purgeStores(keep);
    } catch {
      // Best effort: a blocked or missing IndexedDB must not reach the page.
    }
  }

  /** The local database of the signed-in person. */
  async function ensureStore(personId: string): Promise<SyncStore | null> {
    if (store && storePerson === personId) return store;
    const opened = await deps.openStore(personId);
    if (!opened) return null;
    store = opened;
    storePerson = personId;
    unsubShared = opened.onShared?.(onSharedWrite) ?? null;
    return store;
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
      deps.journal.write({ base: cloneState(lastWritten), at: changedAt });
      journalOwned = true;
    } catch {
      // Best effort.
    }
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
  async function flushLocal(): Promise<boolean> {
    if (!store || !storePerson || !lastWritten) return false;
    const next = cloneState(deps.bridge.read());
    if (sameState(next, lastWritten)) {
      changedAt = null;
      clearRecord();
      return false;
    }
    const at = changedAt ?? deps.now();
    const live = new Map((await store.liveDocs()).map((d) => [d.id, d]));
    const ops = planChangeOps(lastWritten, next, live, docContext(at));
    await applyOps(ops, at);
    lastWritten = next;
    if (sameState(cloneState(deps.bridge.read()), next)) {
      changedAt = null;
      clearRecord();
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
  async function seedOnce(): Promise<boolean> {
    if (!store || !session || !lastWritten) return false;
    if (seededPerson === session.personId) return false;
    const state = cloneState(lastWritten);
    const known = await store.knownIds(candidateIds(state));
    const ops = planSeedOps(state, known, docContext(deps.now()));
    await applyOps(ops, deps.now());
    seededPerson = session.personId;
    return ops.length > 0;
  }

  /**
   * Apply what the documents say, unless the person changed something
   * meanwhile. Resolves true when it had to write a change of the person's
   * first (so the caller replicates again).
   */
  async function applyRemote(): Promise<boolean> {
    if (!store) return false;
    const wrote = await flushLocal();
    const before = cloneState(deps.bridge.read());
    const docs = await store.liveDocs();
    const patch = patchFromDocs(docs, before);
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

  async function replicate(db: SyncStore, s: CouchSession): Promise<void> {
    await writing(() => db.runReplication(s));
  }

  async function cycle(): Promise<void> {
    if (stopped || unavailable || signedOut) return;
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
        dropCredential();
        await applyRemote();
        settled();
        return;
      }
      const s = await ensureSession();
      if (store && storePerson !== s.personId) {
        // A different person is signed in: the previous person's database
        // closes (and is removed below). If it was opened on a guess from the
        // record, what the person changed since this page started is still
        // theirs to write, to their own database; otherwise the baseline
        // starts again.
        const guessed = tentative && startBaseline;
        await closeStore();
        lastWritten = guessed
          ? cloneState(startBaseline as SyncableState)
          : cloneState(deps.bridge.read());
      }
      if (purgedFor !== s.personId) {
        await purge(s.personId);
        purgedFor = s.personId;
      }
      const db = await ensureStore(s.personId);
      if (!db) {
        // No local database, so nothing to sync and no use for a credential.
        unavailable = true;
        dropCredential();
        status = "unavailable";
        return;
      }
      tentative = false; // a credential has said whose database this is
      if (!(await isLeaderOf(db))) {
        dropCredential();
        await applyRemote();
        settled();
        return;
      }
      if (deps.ensureDatabase && ensuredPerson !== s.personId) {
        await deps.ensureDatabase(s);
        ensuredPerson = s.personId;
      }
      await flushLocal();
      await replicate(db, s);
      // A change made while that ran is written before anything is seeded or
      // applied, and pushed by the replication below.
      const flushed = await flushLocal();
      const seeded = await seedOnce();
      const wrote = await applyRemote();
      if (seeded || flushed || wrote) await replicate(db, s);
      settled();
    } catch (err) {
      handleFailure(err);
    }
  }

  /**
   * Nobody is signed in. Idle until the next page load: nothing is counted,
   * nothing is scheduled and nothing asks again. The local database held the
   * previous person's settings, so it is closed and removed.
   */
  function goSignedOut(): void {
    signedOut = true;
    status = "signed_out";
    failures = 0;
    refetchedThisRun = false;
    wakeRequested = false;
    session = null;
    clearAllTimers();
    // A change nobody can write for a person who is not signed in is not left
    // for whoever signs in next on this browser.
    journalOwned = true;
    clearRecord();
    enqueue(async () => {
      await closeStore();
      purgedFor = null;
      await purge(null);
    });
  }

  function handleFailure(err: unknown): void {
    if (stopped) return;
    const fromRoute = err instanceof CouchSessionError;
    const status_ =
      fromRoute || err instanceof CouchHttpError
        ? (err as { status: number }).status
        : undefined;
    const action = failureAction(
      fromRoute ? "route" : "couch",
      status_,
      refetchedThisRun,
    );
    // The database is not there (never prepared, or gone): prepare it again
    // on the next cycle, after the back-off.
    if (!fromRoute && status_ === 404) ensuredPerson = null;

    if (action === "stay_idle") {
      goSignedOut();
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

  function requestSync(wake = false): void {
    if (stopped || signedOut) return;
    if (wake) wakeRequested = true;
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

  function onLocalChange(): void {
    // What the engine itself applied from the server is not the person's edit.
    if (stopped || signedOut || applyingRemote) return;
    changedAt = deps.now();
    // At once and synchronously, before the debounce: a page that closes in
    // the next 750 ms still leaves the change behind.
    recordChange();
    writeTimer = clear(writeTimer);
    writeTimer = deps.setTimer(() => {
      writeTimer = null;
      enqueue(async () => {
        if (stopped || signedOut) return;
        try {
          if (await flushLocal()) schedulePush();
        } catch {
          // The next cycle writes it again.
        }
      });
    }, LOCAL_WRITE_DEBOUNCE_MS);
  }

  /**
   * The shared database changed. If the engine did not do it, another tab did:
   * the leader replicates it (even hidden), a visible follower applies it.
   */
  function onSharedWrite(): void {
    if (stopped || signedOut) return;
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
      unavailable = false;
      signedOut = false;
      status = "idle";
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
      unsubBridge = deps.bridge.subscribe(onLocalChange);
      unsubTrigger = deps.onTrigger?.(onPageTrigger) ?? null;
      enqueue(openLocal);
      requestSync();
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      status = "stopped";
      clearAllTimers();
      unsubBridge?.();
      unsubTrigger?.();
      unsubBridge = null;
      unsubTrigger = null;
      session = null; // the token leaves memory
      cycleWaiting = false;
      wakeRequested = false;
      await chain.catch(() => undefined);
      // The page is going away: a change still inside the debounce is written
      // now (best effort; the journal holds it if this does not complete).
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
      await new Promise<void>((done) => {
        enqueue(async () => {
          try {
            if (!stopped && !signedOut && (await flushLocal())) schedulePush();
          } catch {
            // The journal and the next cycle still hold it.
          } finally {
            done();
          }
        });
      });
    },

    requestSync: () => requestSync(),
    status: () => status,
    async idle() {
      let seen: Promise<void>;
      do {
        seen = chain;
        await seen;
      } while (seen !== chain);
    },
  };
}
