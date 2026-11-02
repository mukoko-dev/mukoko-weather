/**
 * TEST SUPPORT, not shipped: a manual clock, manual timers, a scripted
 * session source, an in-memory `SyncStore` and an app-state bridge for the
 * engine tests. Nothing here waits on real time.
 */

import type {
  EngineDeps,
  SyncBridge,
  SyncStore,
  Trigger,
} from "../couch-sync";
import type { CouchSession } from "../couch-session";
import type {
  SyncableState,
  SyncedPatch,
  UserDocType,
} from "../couch-docs";

export const PERSON = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
export const DEVICE = "11111111-2222-4333-8444-555555555555";
export const START = Date.parse("2026-11-02T10:00:00.000Z");

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
  private listeners = new Set<() => void>();
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
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  /** A change the person makes in the app. */
  change(patch: Partial<SyncableState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) l();
  }
  apply = (patch: SyncedPatch): void => {
    this.applied.push(patch);
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) l();
  };
  get listenerCount(): number {
    return this.listeners.size;
  }
}

export function session(
  over: Partial<CouchSession> & { ttlMs?: number; now?: number } = {},
): CouchSession {
  const personId = over.personId ?? PERSON;
  return {
    token: over.token ?? "credential-for-tests-0123456789",
    expiresAtMs: over.expiresAtMs ?? (over.now ?? START) + (over.ttlMs ?? 600_000),
    database: `user_${personId}`,
    personId,
    databaseUrl: `https://api.test/v1/couch/db/user_${personId}/`,
    ...over,
  };
}

/** An in-memory store whose replication is a script. */
export class FakeStore implements SyncStore {
  docs = new Map<string, UserDocType>();
  deleted = new Set<string>();
  replications = 0;
  closed = false;
  upserts: string[] = [];
  tombstones: string[] = [];
  /** Called on every replication; throw to fail it. */
  onReplicate: (n: number, s: CouchSession) => Promise<void> | void = () =>
    undefined;

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
    this.deleted.delete(doc.id);
    this.docs.set(doc.id, { ...doc });
  }
  async tombstone(id: string) {
    this.tombstones.push(id);
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
}

export function harness(
  options: {
    bridge?: Partial<SyncableState>;
    session?: (n: number, now: number) => Promise<CouchSession>;
    makeStore?: (personId: string) => FakeStore | null;
  } = {},
): Harness {
  const clock = new Clock();
  const bridge = new FakeBridge(options.bridge);
  const stores: FakeStore[] = [];
  const triggers = new Set<(kind: Trigger) => void>();
  const flags = { visible: true, online: true };
  const sessions = { fetched: 0 };
  const nextSession: (n: number, now: number) => Promise<CouchSession> =
    options.session ?? (async (_n, now) => session({ now }));

  const deps: EngineDeps = {
    fetchSession: async () => {
      sessions.fetched += 1;
      return nextSession(sessions.fetched, clock.now);
    },
    openStore: async (personId) => {
      const s = options.makeStore ? options.makeStore(personId) : new FakeStore();
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
  };
  return { clock, bridge, stores, deps, triggers, flags, sessions };
}
