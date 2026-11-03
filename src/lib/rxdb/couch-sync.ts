/**
 * The CouchDB sync engine (mukoko-dev/mukoko-weather#396, web slice).
 *
 * ORCHESTRATION ONLY. Everything it touches is injected: the RxDB layer
 * (`SyncStore`), the app's state (`SyncBridge`), the credential source, the
 * clock and the timers. That is what makes the rules below testable without a
 * database, a browser or a server. The real wiring is `couch-sync-start.ts`;
 * the RxDB layer is `couch-rxdb.ts`.
 *
 * ONE CYCLE (serialised: at most one runs, at most one more waits):
 *
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
 *   4. reconcile    first cycle only: seed documents for settings that
 *                   predate sync AND have no document yet; then apply what the
 *                   documents say to the app. A second replication pushes seeds
 *
 * DEFAULTS NEVER WIN. A device that has not changed a setting writes nothing
 * for it, and seeding only fills ids that have no document at all, so a fresh
 * device with default settings cannot overwrite what the person set elsewhere.
 *
 * FAILURES ARE SILENT AND BOUNDED. No console output, never a throw into a
 * render. 401 from the credential route = signed out: idle, token dropped.
 * 401 from the database = the credential was refused: fetch a new one once,
 * then back off. 403, 404, 429, 5xx, offline and timeouts back off 30 s,
 * doubling to 15 min (`couch-schedule.ts`). `stop()` (sign-out, tab close, a
 * different person) cancels every timer and drops the token from memory.
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
  refreshDelayMs,
} from "./couch-schedule";
import { CouchHttpError } from "./couch-fetch";
import { CouchSessionError, type CouchSession } from "./couch-session";

// ---------------------------------------------------------------------------
// What the engine is given
// ---------------------------------------------------------------------------

/** The local database for one person, as the engine needs it. */
export interface SyncStore {
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
  let status: EngineStatus = "stopped";
  let session: CouchSession | null = null;
  let store: SyncStore | null = null;
  let storePerson: string | null = null;
  let seededPerson: string | null = null;
  /** The person whose server-side database `ensureDatabase` has prepared. */
  let ensuredPerson: string | null = null;
  let lastWritten: SyncableState | null = null;
  let failures = 0;
  let refetchedThisRun = false;
  let lastRunAt = Number.NEGATIVE_INFINITY;

  let chain: Promise<void> = Promise.resolve();
  let cycleWaiting = false;
  let pollTimer: TimerHandle | null = null;
  let backoffTimer: TimerHandle | null = null;
  let refreshTimer: TimerHandle | null = null;
  let writeTimer: TimerHandle | null = null;
  let pushTimer: TimerHandle | null = null;
  let unsubBridge: (() => void) | null = null;
  let unsubTrigger: (() => void) | null = null;

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

  function ctx(): DocContext {
    if (!session) throw new Error("couch-sync: no session");
    return {
      personId: session.personId,
      deviceId: deps.deviceId,
      nowMs: deps.now(),
    };
  }

  async function applyOps(ops: LocalDocOp[]): Promise<void> {
    if (!store) return;
    for (const op of ops) {
      if (op.kind === "upsert") await store.upsert(op.doc);
      else await store.tombstone(op.id, deps.now());
    }
  }

  // -- credential ----------------------------------------------------------

  function scheduleRefresh(s: CouchSession): void {
    refreshTimer = clear(refreshTimer);
    refreshTimer = deps.setTimer(
      () => {
        refreshTimer = null;
        if (stopped) return;
        // A hidden page asks when it is shown again, not on a timer.
        if (!isVisible()) {
          session = null;
          return;
        }
        enqueue(async () => {
          if (stopped) return;
          try {
            session = await deps.fetchSession();
            scheduleRefresh(session);
          } catch (err) {
            session = null;
            handleFailure(err);
          }
        });
      },
      refreshDelayMs(s.expiresAtMs, deps.now()),
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
    const fresh = await deps.fetchSession();
    session = fresh;
    scheduleRefresh(fresh);
    return fresh;
  }

  /** The local database of the signed-in person (a different person = a new one). */
  async function ensureStore(personId: string): Promise<SyncStore | null> {
    if (store && storePerson === personId) return store;
    if (store) {
      await store.close().catch(() => undefined);
      store = null;
      storePerson = null;
      seededPerson = null;
      ensuredPerson = null;
    }
    const opened = await deps.openStore(personId);
    if (!opened) return null;
    store = opened;
    storePerson = personId;
    lastWritten = cloneState(deps.bridge.read());
    return store;
  }

  // -- local writes --------------------------------------------------------

  /** Write the changes made since the last write as documents. */
  async function flushLocal(): Promise<boolean> {
    if (!store || !session || !lastWritten) return false;
    const next = cloneState(deps.bridge.read());
    if (sameState(next, lastWritten)) return false;
    const live = new Map((await store.liveDocs()).map((d) => [d.id, d]));
    const ops = planChangeOps(lastWritten, next, live, ctx());
    await applyOps(ops);
    lastWritten = next;
    return ops.length > 0;
  }

  /** First cycle for a person: fill gaps with settings that predate sync. */
  async function seedOnce(): Promise<boolean> {
    if (!store || !session || seededPerson === session.personId) return false;
    const state = cloneState(deps.bridge.read());
    const known = await store.knownIds(candidateIds(state));
    const ops = planSeedOps(state, known, ctx());
    await applyOps(ops);
    seededPerson = session.personId;
    lastWritten = state;
    return ops.length > 0;
  }

  /** Apply what the documents say, unless the person changed something meanwhile. */
  async function applyRemote(): Promise<void> {
    if (!store) return;
    await flushLocal();
    const before = cloneState(deps.bridge.read());
    const docs = await store.liveDocs();
    const patch = patchFromDocs(docs, before);
    if (Object.keys(patch).length === 0) return;
    // A change made while the documents were read wins: the next cycle sees it.
    if (!sameState(before, deps.bridge.read())) return;
    deps.bridge.apply(patch);
    lastWritten = cloneState(deps.bridge.read());
  }

  // -- one cycle -----------------------------------------------------------

  async function cycle(): Promise<void> {
    if (stopped || unavailable) return;
    if (!isOnline()) {
      status = "backing_off"; // resumes on the "online" event
      return;
    }
    if (!isVisible()) {
      status = "idle"; // resumes on focus / visibility
      return;
    }
    status = "syncing";
    lastRunAt = deps.now();
    try {
      const s = await ensureSession();
      const db = await ensureStore(s.personId);
      if (!db) {
        // No local database, so nothing to sync and no use for a credential.
        unavailable = true;
        session = null;
        refreshTimer = clear(refreshTimer);
        status = "unavailable";
        return;
      }
      if (deps.ensureDatabase && ensuredPerson !== s.personId) {
        await deps.ensureDatabase(s);
        ensuredPerson = s.personId;
      }
      await flushLocal();
      await db.runReplication(s);
      const seeded = await seedOnce();
      await applyRemote();
      if (seeded) await db.runReplication(s);
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
    } catch (err) {
      handleFailure(err);
    }
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

    if (action === "refetch_token_once") {
      session = null;
      refreshTimer = clear(refreshTimer);
      refetchedThisRun = true;
      requestSync();
      return;
    }
    if (action === "stay_idle" || status_ === 401 || status_ === 403) {
      // Signed out, or the credential is refused: do not keep the token.
      session = null;
      refreshTimer = clear(refreshTimer);
    }
    refetchedThisRun = false;
    failures += 1;
    status = action === "stay_idle" ? "signed_out" : "backing_off";
    backoffTimer = clear(backoffTimer);
    backoffTimer = deps.setTimer(
      () => {
        backoffTimer = null;
        requestSync();
      },
      backoffDelayMs(failures, random),
    );
  }

  function requestSync(): void {
    if (stopped || cycleWaiting) return;
    cycleWaiting = true;
    enqueue(async () => {
      cycleWaiting = false;
      await cycle();
    });
  }

  // -- triggers ------------------------------------------------------------

  function onLocalChange(): void {
    if (stopped) return;
    writeTimer = clear(writeTimer);
    writeTimer = deps.setTimer(() => {
      writeTimer = null;
      enqueue(async () => {
        if (stopped) return;
        try {
          if (await flushLocal()) {
            pushTimer = clear(pushTimer);
            pushTimer = deps.setTimer(() => {
              pushTimer = null;
              requestSync();
            }, PUSH_DEBOUNCE_MS);
          }
        } catch {
          // The next cycle writes it again.
        }
      });
    }, LOCAL_WRITE_DEBOUNCE_MS);
  }

  function onPageTrigger(kind: Trigger): void {
    if (stopped) return;
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
      status = "idle";
      unsubBridge = deps.bridge.subscribe(onLocalChange);
      unsubTrigger = deps.onTrigger?.(onPageTrigger) ?? null;
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
      await chain.catch(() => undefined);
      const closing = store;
      store = null;
      storePerson = null;
      seededPerson = null;
      ensuredPerson = null;
      lastWritten = null;
      failures = 0;
      refetchedThisRun = false;
      if (closing) await closing.close().catch(() => undefined);
    },

    requestSync,
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
