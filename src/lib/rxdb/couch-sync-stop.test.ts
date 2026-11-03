/**
 * A page that is going away (pagehide), or is hidden, must write the person's
 * pending change NOW, not after whatever the sync is in the middle of. A cycle
 * can be inside a replication for up to a minute, or waiting on a credential;
 * `stop()`, `flush()` and the write debounce used to queue behind it, so the
 * guarantee failed exactly when a cycle was running. And nothing may wait for
 * ever: a request that never answers must not freeze the whole engine.
 *
 * Manual clock, in-memory store: nothing here waits on real time, except the
 * few awaits that let already-resolved promises run.
 */
import { afterEach, describe, expect, it } from "vitest";
import { OPEN_STORE_TIMEOUT_MS, createCouchSyncEngine } from "./couch-sync";
import { CouchHttpError } from "./couch-fetch";
import { toRfc3339, type SyncableState } from "./couch-docs";
import {
  FakeStore,
  MemoryJournal,
  PERSON,
  harness,
  session,
} from "./test-support/couch-engine-harness";
import { LOCAL_WRITE_DEBOUNCE_MS } from "./couch-schedule";

const engines: { stop(): Promise<void> }[] = [];
const releases: (() => void)[] = [];
afterEach(async () => {
  // Never leave a hung request behind a test.
  for (const release of releases.splice(0)) release();
  while (engines.length) await engines.pop()?.stop();
});

/** Let promises that are already resolved run (store calls, microtasks). */
async function turns(n = 60) {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

async function until(done: () => boolean, max = 600): Promise<boolean> {
  for (let i = 0; i < max && !done(); i += 1) await Promise.resolve();
  return done();
}

/**
 * A store whose FIRST replication runs until the test lets it go (or, when the
 * store supports it, until it is cancelled); the ones after it are instant.
 */
function hangingStore(cancellable: boolean) {
  const store = new FakeStore();
  const state = { released: false };
  let release: () => void = () => undefined;
  store.onReplicate = (n) => {
    if (n !== 1) return undefined;
    return new Promise<void>((resolve, reject) => {
      release = () => {
        state.released = true;
        resolve();
      };
      releases.push(release);
      store.cancelHook = () => reject(new CouchHttpError(0));
    });
  };
  if (!cancellable) store.cancelReplication = undefined as never;
  return { store, state, release: () => release() };
}

async function inTheMiddleOfAReplication(
  options: { cancellable?: boolean; bridge?: Partial<SyncableState> } = {},
) {
  const { store, state, release } = hangingStore(options.cancellable ?? true);
  const journal = new MemoryJournal();
  const h = harness({
    recorded: PERSON,
    makeStore: () => store,
    journal,
    bridge: options.bridge,
  });
  const engine = createCouchSyncEngine(h.deps);
  engines.push(engine);
  await engine.start();
  expect(await until(() => store.replications === 1)).toBe(true);
  return { store, state, release, journal, h, engine };
}

describe("stop() during a long replication", () => {
  it("writes the pending change first, while the replication is still running, and the write clears the journal", async () => {
    const { store, state, journal, h, engine } =
      await inTheMiddleOfAReplication({ cancellable: false });
    const madeAt = h.clock.now;
    h.bridge.change({ theme: "dark" });
    expect(journal.record).not.toBeNull();

    void engine.stop();
    expect(await until(() => store.written.length === 1)).toBe(true);
    // The replication has not finished: the change did not wait for it.
    expect(state.released).toBe(false);
    expect(store.written[0]).toMatchObject({
      id: "preference:theme",
      preferenceValue: "dark",
      updatedAt: toRfc3339(madeAt),
    });
    await turns();
    expect(journal.record).toBeNull();
  });

  it("abandons the replication instead of waiting for it, so stop() resolves on its own, even when the store cannot cancel", async () => {
    for (const cancellable of [true, false]) {
      const { store, state, h, engine } = await inTheMiddleOfAReplication({
        cancellable,
      });
      h.bridge.change({ theme: "dark" });
      let done = false;
      const stopping = engine.stop().then(() => {
        done = true;
      });
      expect(await until(() => done), String(cancellable)).toBe(true);
      await stopping;
      expect(state.released).toBe(false);
      expect(store.cancelled).toBe(cancellable ? 1 : 0);
      expect(store.closed).toBe(true);
      expect(store.written.map((d) => d.id)).toEqual(["preference:theme"]);
    }
  });

  it("the write does not wait for any step of the cycle, not even one that cannot be abandoned (the leader election)", async () => {
    const store = new FakeStore();
    let answered = false;
    store.isLeader = () =>
      new Promise<boolean>((resolve) => {
        releases.push(() => {
          answered = true;
          resolve(true);
        });
      });
    const h = harness({ recorded: PERSON, makeStore: () => store });
    const engine = createCouchSyncEngine(h.deps);
    engines.push(engine);
    await engine.start();
    await turns(); // the first cycle is waiting for the election
    h.bridge.change({ theme: "dark" });
    void engine.stop();
    expect(await until(() => store.written.length === 1)).toBe(true);
    expect(answered).toBe(false);
  });

  it("a replication that fails because it was abandoned does not back off or count as a failure", async () => {
    const { h, engine } = await inTheMiddleOfAReplication();
    await engine.stop();
    await turns();
    expect(h.clock.timerCount).toBe(0);
    expect(engine.status()).toBe("stopped");
  });

  it("a write that fails leaves the journal, and stop() still resolves", async () => {
    const { store, journal, h, engine } = await inTheMiddleOfAReplication();
    store.upsert = async () => {
      throw new Error("quota");
    };
    h.bridge.change({ theme: "dark" });
    await expect(engine.stop()).resolves.toBeUndefined();
    expect(journal.record).not.toBeNull();
  });
});

describe("a cycle ends at its next step once the page has said stop", () => {
  it("no applying and no second replication after a step that was still running", async () => {
    // The first cycle seeds a setting that predates sync; its knownIds read
    // (the start of that step) is held up.
    const store = new FakeStore();
    let openGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
      releases.push(resolve);
    });
    const known = store.knownIds.bind(store);
    store.knownIds = async (ids) => {
      await gate;
      return known(ids);
    };
    store.docs.set("preference:forecastModel", {
      id: "preference:forecastModel",
      type: "preference",
      schemaVersion: 1,
      ownerPersonId: PERSON,
      deviceId: "99999999-2222-4333-8444-555555555555",
      createdAt: "2026-11-02T09:00:00.000Z",
      updatedAt: "2026-11-02T09:00:00.000Z",
      preferenceKey: "forecastModel",
      preferenceValue: "gfs_seamless",
    });
    const h = harness({
      recorded: PERSON,
      makeStore: () => store,
      bridge: { theme: "dark" },
    });
    const engine = createCouchSyncEngine(h.deps);
    engines.push(engine);
    await engine.start();
    expect(await until(() => store.replications === 1)).toBe(true);
    await turns();

    const stopping = engine.stop();
    openGate(); // the step that was running finishes after stop() was called
    await stopping;
    await h.clock.advance(60 * 60_000, async () => turns());

    expect(store.replications).toBe(1); // no second one for the seed
    expect(h.bridge.applied).toEqual([]); // the remote value was not applied
    expect(h.clock.timerCount).toBe(0); // no poll, no backoff, no renewal
  });
});

describe("flush() and the write debounce do not wait for a cycle", () => {
  it("flush() writes while a replication is running", async () => {
    const { store, state, h, engine } = await inTheMiddleOfAReplication({
      cancellable: false,
    });
    h.bridge.change({ theme: "dark" });
    let flushed = false;
    void engine.flush().then(() => {
      flushed = true;
    });
    expect(await until(() => flushed)).toBe(true);
    expect(state.released).toBe(false);
    expect(store.written.map((d) => d.id)).toEqual(["preference:theme"]);
  });

  it("the 750 ms debounce writes while a replication is running", async () => {
    const { store, state, h, engine } = await inTheMiddleOfAReplication({
      cancellable: false,
    });
    h.bridge.change({ theme: "dark" });
    await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, async () => turns());
    expect(store.written.map((d) => d.id)).toEqual(["preference:theme"]);
    expect(state.released).toBe(false);
    expect(engine.status()).toBe("syncing"); // still inside its replication
  });

  it("a change written during the replication is pushed by the next replication, not lost", async () => {
    const { store, release, h, engine } = await inTheMiddleOfAReplication({
      cancellable: false,
    });
    h.bridge.change({ theme: "dark" });
    await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, async () => turns());
    release();
    await engine.idle();
    await h.clock.advance(10_000, async () => {
      await engine.idle();
    });
    expect(store.replications).toBeGreaterThanOrEqual(2);
    expect(store.written).toHaveLength(1);
  });

  it("concurrent flushes write the change once", async () => {
    const store = new FakeStore();
    const h = harness({ recorded: PERSON, makeStore: () => store });
    const engine = createCouchSyncEngine(h.deps);
    engines.push(engine);
    await engine.start();
    await engine.idle();
    h.bridge.change({ theme: "dark" });
    await Promise.all([engine.flush(), engine.flush(), engine.flush()]);
    await engine.idle();
    expect(
      store.written.filter((d) => d.id === "preference:theme"),
    ).toHaveLength(1);
  });
});

describe("nothing waits for ever", () => {
  it("a credential request that never answers does not freeze the engine: stop() still resolves and a restart works", async () => {
    let calls = 0;
    const h = harness({
      recorded: PERSON,
      session: (_n, now) => {
        calls += 1;
        // The first request never answers; later ones do.
        return calls === 1
          ? new Promise<never>(() => undefined)
          : Promise.resolve(session({ now }));
      },
    });
    const engine = createCouchSyncEngine(h.deps);
    engines.push(engine);
    await engine.start();
    await turns();
    expect(h.sessions.fetched).toBe(1);

    let stopped = false;
    void engine.stop().then(() => {
      stopped = true;
    });
    expect(await until(() => stopped)).toBe(true);

    // A page restored from the back/forward cache starts again: its cycle is
    // not queued behind the request that will never answer.
    await engine.start();
    expect(await until(() => h.stores.at(-1)?.replications === 1)).toBe(true);
    expect(h.sessions.fetched).toBe(2);
  });

  it("a local database that never opens times out like any other failure, and a late one is closed, not leaked", async () => {
    const late = new FakeStore();
    let resolveOpen: (s: FakeStore) => void = () => undefined;
    let opens = 0;
    const h = harness({ recorded: PERSON });
    h.deps.openStore = () => {
      opens += 1;
      return opens === 1
        ? new Promise<FakeStore>((resolve) => {
            resolveOpen = resolve;
          })
        : Promise.resolve(new FakeStore());
    };
    const engine = createCouchSyncEngine(h.deps);
    engines.push(engine);
    await engine.start();
    await turns();
    expect(opens).toBe(1); // waiting

    await h.clock.advance(OPEN_STORE_TIMEOUT_MS, async () => turns());
    // The first cycle (a credential, then an open of its own) goes on.
    expect(await until(() => opens >= 2)).toBe(true);

    resolveOpen(late);
    await turns();
    expect(late.closed).toBe(true);
  });

  it("an open that is abandoned by stop() is closed when it finally arrives", async () => {
    const late = new FakeStore();
    let resolveOpen: (s: FakeStore) => void = () => undefined;
    const h = harness({ recorded: PERSON });
    h.deps.openStore = () =>
      new Promise<FakeStore>((resolve) => {
        resolveOpen = resolve;
      });
    const engine = createCouchSyncEngine(h.deps);
    engines.push(engine);
    await engine.start();
    await turns();
    await engine.stop();
    resolveOpen(late);
    await turns();
    expect(late.closed).toBe(true);
  });
});

describe("a stale cycle cannot outlive a stop and a start", () => {
  it("the cycle that was stopped does nothing more when a new run has started", async () => {
    const { store, release, h, engine } = await inTheMiddleOfAReplication({
      cancellable: false,
    });
    const stopping = engine.stop();
    await engine.start(); // restored from the back/forward cache
    release(); // the OLD replication finishes now
    await stopping;
    await engine.idle();
    // The old cycle did not seed, apply or replicate again; the new run's own
    // cycle replicates once.
    expect(store.replications).toBe(2);
    expect(engine.status()).toBe("idle");
    expect(h.clock.timerCount).toBeGreaterThan(0);
  });
});
