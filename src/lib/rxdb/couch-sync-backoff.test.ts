/**
 * Two rules of the engine that a failing service tests:
 *
 *   - EVERY trigger respects the back-off. A local write, another tab's write,
 *     the poll, a focus, a public `requestSync()` and the credential's renewal
 *     all wait for the back-off timer while it runs; only the browser's "online"
 *     event ends it early. A failing service is asked once per wait, not once
 *     per edit.
 *   - A scheduled deletion of the account (`403 account_pending_deletion`) is
 *     terminal for the page's life, like a sign-out as far as asking again goes
 *     (no timer, no further request), but it removes NOTHING.
 *
 * Manual clock; no real time passes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCouchSyncEngine } from "./couch-sync";
import { CouchHttpError } from "./couch-fetch";
import { CouchSessionError } from "./couch-session";
import { PENDING_DELETION_CODE } from "../couch-session-contract";
import {
  FakeStore,
  MemoryJournal,
  PERSON,
  harness,
  session,
} from "./test-support/couch-engine-harness";
import {
  FOCUS_COOLDOWN_MS,
  LOCAL_WRITE_DEBOUNCE_MS,
  POLL_INTERVAL_MS,
  PUSH_DEBOUNCE_MS,
} from "./couch-schedule";

const spies = ["log", "info", "warn", "error", "debug"].map((m) =>
  vi.spyOn(console, m as "log").mockImplementation(() => undefined),
);
afterEach(() => {
  for (const s of spies) s.mockClear();
});

const settleWith = (engine: { idle(): Promise<void> }) => () => engine.idle();
const SECOND = 1_000;

describe("every trigger respects the back-off", () => {
  /** A store whose replications fail with 503 for the first `failures` calls after the first. */
  function failingAfterFirst(failures = Number.POSITIVE_INFINITY) {
    const store = new FakeStore();
    store.onReplicate = (n) => {
      if (n > 1 && n <= 1 + failures) throw new CouchHttpError(503);
    };
    return store;
  }

  it("edits, another tab's writes, a focus and a public request cause no request until the back-off ends, then exactly one", async () => {
    const store = new FakeStore();
    store.onReplicate = (n) => {
      if (n === 1) throw new CouchHttpError(503);
    };
    const h = harness({ makeStore: () => store });
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();
    expect(engine.status()).toBe("backing_off");
    expect(store.replications).toBe(1);
    expect(h.sessions.fetched).toBe(1);
    expect(h.clock.pending()).toContain(30 * SECOND);

    // The person edits (twice), another tab writes, the page is focused and
    // something asks for a sync: ten seconds into a thirty-second wait.
    h.bridge.change({ theme: "dark" });
    await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, settleWith(engine));
    h.bridge.change({ selectedActivities: ["livestock"] });
    await h.clock.advance(
      LOCAL_WRITE_DEBOUNCE_MS + PUSH_DEBOUNCE_MS,
      settleWith(engine),
    );
    store.emitShared();
    await h.clock.advance(PUSH_DEBOUNCE_MS + 100, settleWith(engine));
    h.triggers.forEach((t) => t("focus"));
    engine.requestSync();
    engine.requestSync();
    await h.clock.advance(FOCUS_COOLDOWN_MS - 5 * SECOND, settleWith(engine));

    // The edits are in the local database (durable), nothing was asked of the
    // server: no credential, no replication.
    expect(store.upserts.sort()).toEqual([
      "activity:livestock",
      "preference:theme",
    ]);
    expect(store.replications).toBe(1);
    expect(h.sessions.fetched).toBe(1);
    expect(engine.status()).toBe("backing_off");

    // The wait ends: ONE cycle, which carries both edits.
    await h.clock.advance(30 * SECOND, settleWith(engine));
    expect(store.replications).toBeGreaterThanOrEqual(2);
    const afterTimer = store.replications;
    expect(engine.status()).toBe("idle");
    // ...and it asked once, not once per edit or request.
    expect(afterTimer).toBeLessThanOrEqual(3);
    await engine.stop();
  });

  it("a cycle already queued behind the one that failed does not run either", async () => {
    const store = new FakeStore();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.onReplicate = async () => {
      await gate;
      throw new CouchHttpError(503);
    };
    const h = harness({ makeStore: () => store });
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    // The first cycle is inside its replication, waiting on the gate.
    for (let i = 0; i < 50 && store.replications === 0; i += 1) {
      await Promise.resolve();
    }
    expect(store.replications).toBe(1);
    // An edit and a request arrive meanwhile: one more cycle is queued.
    engine.requestSync();
    release();
    await engine.idle();
    expect(engine.status()).toBe("backing_off");
    expect(store.replications).toBe(1);
    expect(h.sessions.fetched).toBe(1);
    await engine.stop();
  });

  it("the poll timer of an earlier good cycle, firing inside a later back-off, asks for nothing", async () => {
    const store = new FakeStore();
    store.onReplicate = (n) => {
      if (n === 2) throw new CouchHttpError(503); // the push cycle fails
    };
    const h = harness({ makeStore: () => store });
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();
    expect(store.replications).toBe(1); // good: the poll is armed for t = 60 s

    // An edit at t = 50 s is written, and its push at about t = 52.75 s fails:
    // a 30 s back-off that ends at about t = 82.75 s, which contains the poll.
    await h.clock.advance(50 * SECOND, settleWith(engine));
    h.bridge.change({ theme: "dark" });
    await h.clock.advance(
      LOCAL_WRITE_DEBOUNCE_MS + PUSH_DEBOUNCE_MS,
      settleWith(engine),
    );
    expect(store.replications).toBe(2);
    expect(engine.status()).toBe("backing_off");

    await h.clock.advance(15 * SECOND, settleWith(engine)); // t ~ 68 s: past the poll
    expect(store.replications).toBe(2);

    await h.clock.advance(20 * SECOND, settleWith(engine)); // t ~ 88 s: past the wait
    expect(store.replications).toBe(3);
    expect(engine.status()).toBe("idle");
    await engine.stop();
  });

  it("the credential's renewal timer, firing inside a back-off, does not call the route", async () => {
    // Every replication after the first fails: waits of 30, 60 and 120 s follow
    // the poll at t = 60 s, so the renewal timer (a minute before the credential
    // ends, t = 240 s) fires at t = 240 s inside the wait that ends at t = 270 s.
    const store = failingAfterFirst();
    const h = harness({ makeStore: () => store });
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();
    expect(h.sessions.fetched).toBe(1);

    await h.clock.advance(245 * SECOND, settleWith(engine));
    expect(engine.status()).toBe("backing_off");
    expect(h.sessions.fetched).toBe(1); // the renewal asked for nothing

    await h.clock.advance(20 * SECOND, settleWith(engine)); // t = 265 s
    expect(h.sessions.fetched).toBe(1);

    await h.clock.advance(10 * SECOND, settleWith(engine)); // t = 275 s: the wait ended
    expect(h.sessions.fetched).toBe(2); // the cycle asked, once, for what it needs
    await engine.stop();
  });

  it("a long failure is asked once per wait however busy the page is", async () => {
    const store = failingAfterFirst();
    const h = harness({ makeStore: () => store });
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();

    // Ten minutes in which the person edits every 20 seconds and the page is
    // focused and the network flaps: back-off waits are 30, 60, 120, 240 s...
    for (let i = 0; i < 30; i += 1) {
      h.bridge.change({ theme: i % 2 === 0 ? "dark" : "light" });
      await h.clock.advance(20 * SECOND, settleWith(engine));
      h.triggers.forEach((t) => t("focus"));
      store.emitShared();
    }
    // First attempt, then those at t = 60 (poll), 90, 150, 270, 510: six at most.
    expect(store.replications).toBeLessThanOrEqual(6);
    await engine.stop();
  });

  it("the browser's 'online' event still ends a back-off at once", async () => {
    const store = failingAfterFirst(1);
    const h = harness({ makeStore: () => store });
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();
    await h.clock.advance(POLL_INTERVAL_MS, settleWith(engine)); // fails: back-off
    expect(engine.status()).toBe("backing_off");
    const before = store.replications;
    h.triggers.forEach((t) => t("online"));
    await engine.idle();
    expect(store.replications).toBe(before + 1);
    expect(engine.status()).toBe("idle");
    await engine.stop();
  });

  it("stopping during a back-off leaves no timer", async () => {
    const store = new FakeStore();
    store.onReplicate = () => {
      throw new CouchHttpError(503);
    };
    const h = harness({ makeStore: () => store });
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();
    await engine.stop();
    expect(h.clock.pending()).toEqual([]);
  });
});

describe("a scheduled deletion of the account is terminal and removes nothing", () => {
  const pending = () => new CouchSessionError(403, PENDING_DELETION_CODE);

  it("the first answer idles the engine: no timer, and not one more request in two hours of everything a page does", async () => {
    const h = harness({
      session: async () => {
        throw pending();
      },
    });
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();
    expect(engine.status()).toBe("account_closing");
    expect(h.sessions.fetched).toBe(1);
    expect(h.clock.pending()).toEqual([]);

    for (let i = 0; i < 360; i += 1) {
      await h.clock.advance(20 * SECOND, settleWith(engine));
      h.triggers.forEach((t) => t("focus"));
      if (i % 60 === 0) h.triggers.forEach((t) => t("online"));
      if (i % 45 === 0) {
        h.bridge.change({ theme: i % 90 === 0 ? "dark" : "light" });
      }
      engine.requestSync();
      await engine.idle();
    }
    expect(h.sessions.fetched).toBe(1);
    expect(engine.status()).toBe("account_closing");
    expect(h.stores).toHaveLength(0);
    await engine.stop();
  });

  it("removes nothing: no local database purged, no mark left, and the record of unwritten changes stays", async () => {
    const journal = new MemoryJournal();
    const h = harness({
      recorded: PERSON,
      journal,
      session: async () => {
        throw pending();
      },
    });
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();
    expect(engine.status()).toBe("account_closing");

    // The person's changes are still written to the local database.
    h.bridge.change({ theme: "dark" });
    await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS + 100, settleWith(engine));
    expect(h.stores).toHaveLength(1);
    expect(h.stores[0].upserts).toContain("preference:theme");
    expect(h.stores[0].closed).toBe(false);
    expect(h.stores[0].replications).toBe(0);
    expect(h.purged).toEqual([]);
    expect(h.marker.writes).toBe(0);
    expect(h.marker.clears).toBe(0);
    // That database was opened on a guess (no credential has named the person),
    // so the change is not durable yet and its record is kept, not cleared.
    expect(journal.record).not.toBeNull();
    expect(h.sessions.fetched).toBe(1);

    // Stopping the page writes a last pending change too (it is not a sign-out).
    h.bridge.change({ theme: "light" });
    await engine.stop();
    expect(
      h.stores[0].upserts.filter((i) => i === "preference:theme").length,
    ).toBeGreaterThanOrEqual(2);
    expect(h.purged).toEqual([]);
  });

  it("after a session that worked: the store stays open and nothing is purged for anybody", async () => {
    let n = 0;
    const h = harness({
      session: async (_n, now) => {
        n += 1;
        if (n >= 2) throw pending();
        return session({ now });
      },
    });
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();
    expect(engine.status()).toBe("idle");
    expect(h.purged).toEqual([PERSON]); // the usual: everyone but this person

    // The renewal (a minute before the credential ends) hears the refusal.
    await h.clock.advance(4 * 60 * SECOND, settleWith(engine));
    expect(engine.status()).toBe("account_closing");
    expect(h.stores[0].closed).toBe(false);
    expect(h.purged).toEqual([PERSON]); // never `null`: nobody is signed out
    expect(h.marker.writes).toBe(0);
    expect(h.clock.pending()).toEqual([]);

    // Nothing asks again (the polls of the minutes before are all there was).
    const replicated = h.stores[0].replications;
    await h.clock.advance(2 * 60 * 60 * SECOND, settleWith(engine));
    expect(h.sessions.fetched).toBe(2);
    expect(h.stores[0].replications).toBe(replicated);
    await engine.stop();
  });

  it("is for the page's life only: a restart (a page restored from the cache) asks once more", async () => {
    let allowed = false;
    const h = harness({
      session: async (_n, now) => {
        if (!allowed) throw pending();
        return session({ now });
      },
    });
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();
    expect(engine.status()).toBe("account_closing");
    await engine.stop();

    allowed = true; // the deletion was cancelled
    await engine.start();
    await engine.idle();
    expect(h.sessions.fetched).toBe(2);
    expect(engine.status()).toBe("idle");
    await engine.stop();
  });

  it("another 403, or the same code on any other status, is an ordinary failure that backs off and retries", async () => {
    for (const err of [
      () => new CouchSessionError(403, "forbidden"),
      () => new CouchSessionError(503, PENDING_DELETION_CODE),
      () => new CouchSessionError(401, PENDING_DELETION_CODE),
    ]) {
      const h = harness({
        session: async () => {
          throw err();
        },
      });
      const engine = createCouchSyncEngine(h.deps);
      await engine.start();
      await engine.idle();
      expect(engine.status(), String(err())).not.toBe("account_closing");
      expect(h.clock.pending().length).toBeGreaterThan(0);
      await engine.stop();
    }
  });
});

describe("an engine given a device id the validator would refuse does not start", () => {
  it.each([
    "device",
    "",
    "11111111-2222-4333-8444-55555555555X",
    "ABCDEF01-2222-4333-8444-555555555555",
  ])("%j", async (deviceId) => {
    const h = harness();
    const engine = createCouchSyncEngine({ ...h.deps, deviceId });
    await engine.start();
    await engine.idle();
    expect(engine.status()).toBe("unavailable");
    expect(h.sessions.fetched).toBe(0);
    expect(h.stores).toHaveLength(0);
    expect(h.clock.pending()).toEqual([]);
    expect(h.bridge.listenerCount).toBe(0);
    await engine.stop();
  });
});
