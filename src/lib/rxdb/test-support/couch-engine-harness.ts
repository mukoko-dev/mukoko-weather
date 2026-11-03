/**
 * TEST SUPPORT, not shipped: a manual clock, manual timers, a scripted
 * session source, an in-memory `SyncStore` and an app-state bridge for the
 * engine tests. Nothing here waits on real time.
 */

import type {
  ChangeJournal,
  ChangeOrigin,
  EngineDeps,
  JournalRecord,
  SignedOutMarker,
  SyncBridge,
  SyncStore,
  Trigger,
} from "../couch-sync";
import type { CouchSession } from "../couch-session";
import type { SyncableState, SyncedPatch, UserDocType } from "../couch-docs";

export const PERSON = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
export const DEVICE = "11111111-2222-4333-8444-555555555555";
export const START = Date.parse("2026-11-02T10:00:00.000Z");
/** How long a sync grant lives at most (nyuchi-api `COUCH_SYNC_MAX_SECONDS`). */
export const GRANT_TTL_MS = 300_000;

export class Clock {
  now = START;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();

  setTimer = (fn: () => void, ms: number): unknown => {
    this.seq += 1;
    this.timers.set(this.seq, { at: this.now + ms, fn });
    return this.seq;
  };
  clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };
  /** Delays of the timers that are waiting, soonest first. */
  pending(): number[] {
    return [...this.timers.values()]
      .map((t) => t.at - this.now)
      .sort((a, b) => a - b);
  }
  get timerCount(): number {
    return this.timers.size;
  }
  /** Move time forward, firing due timers in order. `settle` runs after each. */
  async advance(ms: number, settle: () => Promise<void>): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.now = Math.max(this.now, due[1].at);
      this.timers.delete(due[0]);
      due[1].fn();
      await settle();
    }
    this.now = target;
    await settle();
  }
}

export class FakeBridge implements SyncBridge {
  state: SyncableState;
  applied: SyncedPatch[] = [];
  private listeners = new Set<(origin?: ChangeOrigin) => void>();
  constructor(initial: Partial<SyncableState> = {}) {
    this.state = {
      theme: "system",
      selectedForecastModel: "best_match",
      selectedActivities: [],
      ...initial,
    };
  }
  read = (): SyncableState => ({
    ...this.state,
    selectedActivities: [...this.state.selectedActivities],
  });
  subscribe = (listener: (origin?: ChangeOrigin) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  /** A change the person makes in the app. */
  change(patch: Partial<SyncableState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) l("person");
  }
  /**
   * A change that is NOT the person's edit here: a value the app's own
   * preferences store applied (a `/v1/devices` pull, another tab).
   */
  changeFromElsewhere(patch: Partial<SyncableState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) l("applied");
  }
  /** The store notifies although nothing differs (a fresh array of the same ids). */
  noise(): void {
    for (const l of [...this.listeners]) l("person");
  }
  apply = (patch: SyncedPatch): void => {
    this.applied.push(patch);
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) l("person");
  };
  get listenerCount(): number {
    return this.listeners.size;
  }
}

/**
 * The record of changes not yet written to documents, in memory. What
 * `sync-pending.ts` keeps in web storage in the browser: it survives an engine
 * (a page load) because a test hands the same object to the next one.
 */
export class MemoryJournal implements ChangeJournal {
  record: JournalRecord | null = null;
  writes = 0;
  clears = 0;
  read(): JournalRecord | null {
    return this.record
      ? {
          at: this.record.at,
          base: {
            ...this.record.base,
            selectedActivities: [...this.record.base.selectedActivities],
          },
        }
      : null;
  }
  write(record: JournalRecord): void {
    this.writes += 1;
    this.record = {
      at: record.at,
      base: {
        ...record.base,
        selectedActivities: [...record.base.selectedActivities],
      },
    };
  }
  clear(): void {
    this.clears += 1;
    this.record = null;
  }
}

/**
 * The mark the first "nobody is signed in" answer leaves, in memory. What
 * `sync-signed-out.ts` keeps in web storage in the browser: it survives an
 * engine (a page load) because a test hands the same object to the next one.
 */
export class MemorySignedOutMarker implements SignedOutMarker {
  at: number | null = null;
  writes = 0;
  clears = 0;
  read(): number | null {
    return this.at;
  }
  write(atMs: number): void {
    this.writes += 1;
    this.at = atMs;
  }
  clear(): void {
    this.clears += 1;
    this.at = null;
  }
}

/**
 * A credential as the route's answer parses: a lifetime from issue, never a
 * time of day. (`now` is accepted and ignored: older tests pass the clock.)
 */
export function session(
  over: Partial<CouchSession> & { ttlMs?: number; now?: number } = {},
): CouchSession {
  const { ttlMs, now: _now, ...fields } = over;
  void _now;
  const personId = fields.personId ?? PERSON;
  return {
    token: "credential-for-tests-0123456789",
    expiresInMs: ttlMs ?? GRANT_TTL_MS,
    database: `user_${personId}`,
    personId,
    databaseUrl: `https://api.test/v1/couch/db/user_${personId}/`,
    ...fields,
  };
}

/** An in-memory store whose replication is a script. */
export class FakeStore implements SyncStore {
  docs = new Map<string, UserDocType>();
  deleted = new Set<string>();
  replications = 0;
  closed = false;
  upserts: string[] = [];
  /** Every document written, as written (for `updatedAt` assertions). */
  written: UserDocType[] = [];
  tombstones: string[] = [];
  /** Every deletion as asked for: the id, the time stamped and the install. */
  tombstoned: { id: string; nowMs: number; deviceId: string }[] = [];
  /** `undefined` = no leader election (a single instance, always leader). */
  leader: boolean | undefined = undefined;
  private sharedListeners = new Set<() => void>();
  /** Called on every replication; throw to fail it. */
  onReplicate: (n: number, s: CouchSession) => Promise<void> | void = () =>
    undefined;
  /** How many times the engine asked to abandon the running replication. */
  cancelled = 0;
  /** Set by a test whose replication waits: what `cancelReplication` should do. */
  cancelHook: (() => void) | null = null;

  cancelReplication() {
    this.cancelled += 1;
    this.cancelHook?.();
  }

  async isLeader() {
    return this.leader ?? true;
  }
  onShared(listener: () => void) {
    this.sharedListeners.add(listener);
    return () => {
      this.sharedListeners.delete(listener);
    };
  }
  get sharedListenerCount(): number {
    return this.sharedListeners.size;
  }
  /** Another tab wrote to the shared database. */
  emitShared(): void {
    for (const l of [...this.sharedListeners]) l();
  }

  async liveDocs() {
    return [...this.docs.values()].map((d) => ({ ...d }));
  }
  async knownIds(ids: string[]) {
    return new Set(
      ids.filter((id) => this.docs.has(id) || this.deleted.has(id)),
    );
  }
  async upsert(doc: UserDocType) {
    this.upserts.push(doc.id);
    this.written.push({ ...doc });
    this.deleted.delete(doc.id);
    this.docs.set(doc.id, { ...doc });
  }
  async tombstone(id: string, nowMs: number, deviceId: string) {
    this.tombstones.push(id);
    this.tombstoned.push({ id, nowMs, deviceId });
    this.docs.delete(id);
    this.deleted.add(id);
  }
  async runReplication(s: CouchSession) {
    this.replications += 1;
    await this.onReplicate(this.replications, s);
  }
  async close() {
    this.closed = true;
  }
}

export interface Harness {
  clock: Clock;
  bridge: FakeBridge;
  stores: FakeStore[];
  deps: EngineDeps;
  triggers: Set<(kind: Trigger) => void>;
  flags: { visible: boolean; online: boolean };
  /** How many credentials were asked for. */
  sessions: { fetched: number };
  /** The sessions `ensureDatabase` was called with, in order. */
  ensured: CouchSession[];
  /** The `keep` argument of every `purgeStores` call, in order. */
  purged: (string | null)[];
  /** The mark the first "nobody is signed in" answer leaves. */
  marker: MemorySignedOutMarker;
}

export function harness(
  options: {
    bridge?: Partial<SyncableState>;
    session?: (n: number, now: number) => Promise<CouchSession>;
    makeStore?: (personId: string) => FakeStore | null;
    /** Runs when the engine prepares the server-side database; throw to fail it. */
    ensure?: (n: number, s: CouchSession) => Promise<void> | void;
    /** Runs when the engine purges other people's local databases; may throw. */
    purge?: (keep: string | null) => Promise<void> | void;
    /**
     * The person whose local database this browser already holds (the engine
     * opens it at start, before any credential). Omit for a browser that has
     * none yet: the first session of a person.
     */
    recorded?: string | null;
    /** Where changes not yet written to documents are kept between page loads. */
    journal?: ChangeJournal;
    /** Where the first "signed out" answer is remembered between page loads. */
    marker?: MemorySignedOutMarker;
  } = {},
): Harness {
  const marker = options.marker ?? new MemorySignedOutMarker();
  const clock = new Clock();
  const bridge = new FakeBridge(options.bridge);
  const stores: FakeStore[] = [];
  const triggers = new Set<(kind: Trigger) => void>();
  const flags = { visible: true, online: true };
  const sessions = { fetched: 0 };
  const ensured: CouchSession[] = [];
  const purged: (string | null)[] = [];
  const nextSession: (n: number, now: number) => Promise<CouchSession> =
    options.session ?? (async (_n, now) => session({ now }));

  const deps: EngineDeps = {
    fetchSession: async () => {
      sessions.fetched += 1;
      return nextSession(sessions.fetched, clock.now);
    },
    ensureDatabase: async (s) => {
      ensured.push(s);
      await options.ensure?.(ensured.length, s);
    },
    purgeStores: async (keep) => {
      purged.push(keep);
      await options.purge?.(keep);
    },
    openStore: async (personId) => {
      const s = options.makeStore
        ? options.makeStore(personId)
        : new FakeStore();
      if (s) stores.push(s);
      return s;
    },
    bridge,
    deviceId: DEVICE,
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0.5,
    isVisible: () => flags.visible,
    isOnline: () => flags.online,
    onTrigger: (listener) => {
      triggers.add(listener);
      return () => triggers.delete(listener);
    },
    ...(options.recorded !== undefined
      ? { recordedPerson: () => options.recorded ?? null }
      : {}),
    ...(options.journal ? { journal: options.journal } : {}),
    signedOutMarker: marker,
  };
  return {
    clock,
    bridge,
    stores,
    deps,
    triggers,
    flags,
    sessions,
    ensured,
    purged,
    marker,
  };
}
