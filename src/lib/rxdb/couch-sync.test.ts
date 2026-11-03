/**
 * The engine's rules, with a manual clock and an in-memory store: credential
 * lifetime, failure handling and back-off, the triggers, local writes, and a
 * clean stop. No real time passes in any test.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCouchSyncEngine } from "./couch-sync";
import { CouchHttpError } from "./couch-fetch";
import { CouchSessionError } from "./couch-session";
import {
  FakeStore,
  GRANT_TTL_MS,
  PERSON,
  harness,
  session,
  type Harness,
} from "./test-support/couch-engine-harness";
import {
  BACKOFF_MAX_MS,
  FOCUS_COOLDOWN_MS,
  LOCAL_WRITE_DEBOUNCE_MS,
  POLL_INTERVAL_MS,
  PUSH_DEBOUNCE_MS,
  REFRESH_LEAD_MS,
} from "./couch-schedule";

const spies = ["log", "info", "warn", "error", "debug"].map((m) =>
  vi.spyOn(console, m as "log").mockImplementation(() => undefined),
);

afterEach(() => {
  for (const s of spies) s.mockClear();
});

async function started(h: Harness) {
  const engine = createCouchSyncEngine(h.deps);
  await engine.start();
  await engine.idle();
  return engine;
}

const settleWith = (engine: { idle(): Promise<void> }) => () => engine.idle();

describe("a normal cycle", () => {
  it("asks for one credential, opens the person's store and replicates", async () => {
    const h = harness();
    const engine = await started(h);
    expect(h.sessions.fetched).toBe(1);
    expect(h.stores).toHaveLength(1);
    expect(h.stores[0].replications).toBe(1);
    expect(engine.status()).toBe("idle");
    await engine.stop();
  });

  it("polls once a minute while the page is visible, reusing the credential", async () => {
    const h = harness();
    const engine = await started(h);
    await h.clock.advance(POLL_INTERVAL_MS, settleWith(engine));
    expect(h.stores[0].replications).toBe(2);
    await h.clock.advance(POLL_INTERVAL_MS, settleWith(engine));
    expect(h.stores[0].replications).toBe(3);
    expect(h.sessions.fetched).toBe(1);
    await engine.stop();
  });

  it("pushes the seeds of settings that predate sync in a second replication", async () => {
    const h = harness({
      bridge: { theme: "dark", selectedActivities: ["livestock"] },
    });
    const engine = await started(h);
    expect(h.stores[0].upserts.sort()).toEqual([
      "activity:livestock",
      "preference:theme",
    ]);
    expect(h.stores[0].replications).toBe(2);
    await engine.stop();
  });

  it("a fresh device with default settings writes nothing", async () => {
    const h = harness();
    const engine = await started(h);
    expect(h.stores[0].upserts).toEqual([]);
    expect(h.stores[0].replications).toBe(1);
    await engine.stop();
  });
});

describe("preparing the person's database on the server", () => {
  it("once per person, before the first replication, and not again on later cycles", async () => {
    const order: string[] = [];
    const store = new FakeStore();
    store.onReplicate = () => {
      order.push("replicate");
    };
    const h = harness({
      makeStore: () => store,
      ensure: () => {
        order.push("ensure");
      },
    });
    const engine = await started(h);
    await h.clock.advance(POLL_INTERVAL_MS, settleWith(engine));
    await h.clock.advance(POLL_INTERVAL_MS, settleWith(engine));
    expect(order).toEqual(["ensure", "replicate", "replicate", "replicate"]);
    expect(h.ensured).toHaveLength(1);
    expect(h.ensured[0].personId).toBe(PERSON);
    await engine.stop();
  });

  it("is given the credential that was just issued, and a renewal does not prepare again", async () => {
    const h = harness();
    const engine = await started(h);
    await h.clock.advance(GRANT_TTL_MS, settleWith(engine));
    expect(h.sessions.fetched).toBe(2);
    expect(h.ensured).toHaveLength(1);
    expect(h.ensured[0].token).toBe("credential-for-tests-0123456789");
    await engine.stop();
  });

  it("a failure backs off like any other and replicates nothing meanwhile; the retry prepares again", async () => {
    let calls = 0;
    const h = harness({
      ensure: () => {
        calls += 1;
        if (calls === 1) throw new CouchHttpError(503);
      },
    });
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();
    expect(engine.status()).toBe("backing_off");
    expect(h.clock.pending()).toContain(30_000);
    expect(h.stores[0].replications).toBe(0);

    await h.clock.advance(30_000, settleWith(engine));
    expect(h.ensured).toHaveLength(2);
    expect(h.stores[0].replications).toBe(1);
    expect(engine.status()).toBe("idle");
    await engine.stop();
  });

  it("403 (the client is no longer permitted, or the account is being deleted) drops the credential and backs off", async () => {
    const h = harness({
      ensure: () => {
        throw new CouchHttpError(403);
      },
    });
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();
    expect(engine.status()).toBe("backing_off");
    expect(h.stores[0].replications).toBe(0);
    await h.clock.advance(30_000, settleWith(engine));
    // A new credential was asked for: the refused one was not kept.
    expect(h.sessions.fetched).toBe(2);
    await engine.stop();
  });

  it("401 asks for one new credential and prepares again at once", async () => {
    let calls = 0;
    const h = harness({
      ensure: () => {
        calls += 1;
        if (calls === 1) throw new CouchHttpError(401);
      },
    });
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();
    expect(h.sessions.fetched).toBe(2);
    expect(h.ensured).toHaveLength(2);
    expect(h.stores[0].replications).toBe(1);
    expect(engine.status()).toBe("idle");
    await engine.stop();
  });

  it("a 404 from the database means it is gone: the next cycle prepares it again", async () => {
    let n = 0;
    const store = new FakeStore();
    store.onReplicate = () => {
      n += 1;
      if (n === 2) throw new CouchHttpError(404);
    };
    const h = harness({ makeStore: () => store });
    const engine = await started(h);
    expect(h.ensured).toHaveLength(1);
    await h.clock.advance(POLL_INTERVAL_MS, settleWith(engine)); // the 404
    expect(engine.status()).toBe("backing_off");
    await h.clock.advance(30_000, settleWith(engine));
    expect(h.ensured).toHaveLength(2);
    expect(engine.status()).toBe("idle");
    await engine.stop();
  });

  it("nothing is prepared when the device cannot open its local database", async () => {
    const h = harness({ makeStore: () => null });
    const engine = await started(h);
    expect(engine.status()).toBe("unavailable");
    expect(h.ensured).toEqual([]);
    await engine.stop();
  });

  it("a restart (stop, then start) prepares again; a different person is prepared too", async () => {
    const h = harness();
    const engine = await started(h);
    await engine.stop();
    await engine.start();
    await engine.idle();
    expect(h.ensured).toHaveLength(2);
    await engine.stop();

    const other = "0190ffff-0000-7000-8000-00000000abcd";
    const h2 = harness({
      session: async (_n, now) => session({ now, personId: other }),
    });
    const e2 = await started(h2);
    expect(h2.ensured.map((s) => s.personId)).toEqual([other]);
    await e2.stop();
  });

  it("an engine given no way to prepare it works as before", async () => {
    const h = harness();
    delete h.deps.ensureDatabase;
    const engine = await started(h);
    expect(h.stores[0].replications).toBe(1);
    expect(engine.status()).toBe("idle");
    await engine.stop();
  });
});

describe("credential lifetime", () => {
  it("asks again a minute before it expires, while the page is visible", async () => {
    const h = harness();
    const engine = await started(h);
    expect(h.sessions.fetched).toBe(1);
    await h.clock.advance(
      GRANT_TTL_MS - REFRESH_LEAD_MS - 1_000,
      settleWith(engine),
    );
    expect(h.sessions.fetched).toBe(1);
    await h.clock.advance(1_000, settleWith(engine));
    expect(h.sessions.fetched).toBe(2);
    await engine.stop();
  });

  it("a hidden page lets it lapse and asks when shown again", async () => {
    const h = harness();
    const engine = await started(h);
    h.flags.visible = false;
    await h.clock.advance(GRANT_TTL_MS, settleWith(engine));
    expect(h.sessions.fetched).toBe(1);
    h.flags.visible = true;
    h.triggers.forEach((t) => t("focus"));
    await engine.idle();
    expect(h.sessions.fetched).toBe(2);
    await engine.stop();
  });
});

describe("failures", () => {
  it("401 from the database: one new credential and an immediate retry", async () => {
    let first = true;
    const store = new FakeStore();
    store.onReplicate = () => {
      if (first) {
        first = false;
        throw new CouchHttpError(401);
      }
    };
    const h = harness({ makeStore: () => store });
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();
    expect(h.sessions.fetched).toBe(2);
    expect(store.replications).toBe(2);
    expect(engine.status()).toBe("idle");
    await engine.stop();
  });

  it("a second 401 backs off and drops the credential", async () => {
    const store = new FakeStore();
    store.onReplicate = () => {
      throw new CouchHttpError(401);
    };
    const h = harness({ makeStore: () => store });
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();
    expect(h.sessions.fetched).toBe(2);
    expect(store.replications).toBe(2);
    expect(engine.status()).toBe("backing_off");
    expect(h.clock.pending()).toContain(30_000);
    await engine.stop();
  });

  it("signed out (401 from the route): idle, nothing opened, a quiet re-check later", async () => {
    const h = harness({
      session: async () => {
        throw new CouchSessionError(401, "unauthorized");
      },
    });
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();
    expect(engine.status()).toBe("signed_out");
    expect(h.stores).toHaveLength(0);
    expect(h.clock.pending()).toEqual([30_000]);
    await engine.stop();
  });

  it("signed out in another tab: the next credential request is a 401, the token is dropped and replication stops", async () => {
    let signedOut = false;
    const h = harness({
      session: async (_n, now) => {
        if (signedOut) throw new CouchSessionError(401, "unauthorized");
        return session({ now });
      },
    });
    const engine = await started(h);
    expect(h.stores[0].replications).toBe(1);

    signedOut = true;
    // The credential lapses; the poll then asks the route again.
    await h.clock.advance(GRANT_TTL_MS, settleWith(engine));
    expect(engine.status()).toBe("signed_out");
    const replications = h.stores[0].replications;
    // No more replication, only occasional quiet re-checks at the back-off pace.
    await h.clock.advance(30 * 60_000, settleWith(engine));
    expect(h.stores[0].replications).toBe(replications);
    expect(h.sessions.fetched).toBeLessThan(10);
    await engine.stop();
  });

  it("route 404 and 503 stay local-only and back off 30 s, doubling to 15 min", async () => {
    for (const status of [404, 503]) {
      const h = harness({
        session: async () => {
          throw new CouchSessionError(status, "couch_unavailable");
        },
      });
      const engine = createCouchSyncEngine(h.deps);
      await engine.start();
      await engine.idle();
      const waits: number[] = [];
      for (let i = 0; i < 8; i++) {
        const next = h.clock.pending()[0];
        waits.push(next);
        await h.clock.advance(next, settleWith(engine));
      }
      expect(waits).toEqual([
        30_000,
        60_000,
        120_000,
        240_000,
        480_000,
        BACKOFF_MAX_MS,
        BACKOFF_MAX_MS,
        BACKOFF_MAX_MS,
      ]);
      expect(engine.status()).toBe("backing_off");
      expect(h.stores).toHaveLength(0);
      await engine.stop();
    }
  });

  it("a success after failures resets the wait to 30 s", async () => {
    let calls = 0;
    const h = harness({
      session: async (_n, now) => {
        calls += 1;
        if (calls <= 3) throw new CouchSessionError(503, "couch_unavailable");
        return session({ now });
      },
    });
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();
    for (let i = 0; i < 3; i++) {
      await h.clock.advance(h.clock.pending()[0], settleWith(engine));
    }
    expect(engine.status()).toBe("idle");
    // Now fail again: the first wait is back to 30 s, not 4 min.
    h.stores[0].onReplicate = () => {
      throw new CouchHttpError(503);
    };
    await h.clock.advance(POLL_INTERVAL_MS, settleWith(engine));
    expect(h.clock.pending()).toContain(30_000);
    await engine.stop();
  });

  it("403, 429, 5xx and no answer from the database all back off", async () => {
    for (const status of [403, 429, 500, 502, 0]) {
      const store = new FakeStore();
      store.onReplicate = () => {
        throw new CouchHttpError(status);
      };
      const h = harness({ makeStore: () => store });
      const engine = createCouchSyncEngine(h.deps);
      await engine.start();
      await engine.idle();
      expect(engine.status(), `status ${status}`).toBe("backing_off");
      expect(h.clock.pending(), `status ${status}`).toContain(30_000);
      expect(store.replications, `status ${status}`).toBe(1);
      await engine.stop();
    }
  });

  it("offline does nothing and does not count as a failure; 'online' resumes at once", async () => {
    const h = harness();
    h.flags.online = false;
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();
    expect(h.sessions.fetched).toBe(0);
    h.flags.online = true;
    h.triggers.forEach((t) => t("online"));
    await engine.idle();
    expect(h.sessions.fetched).toBe(1);
    expect(h.stores[0].replications).toBe(1);
    await engine.stop();
  });

  it("an 'online' event cancels a pending back-off and starts over from 30 s", async () => {
    let fail = true;
    const store = new FakeStore();
    store.onReplicate = () => {
      if (fail) throw new CouchHttpError(503);
    };
    const h = harness({ makeStore: () => store });
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();
    await h.clock.advance(30_000, settleWith(engine)); // second failure: 60 s next
    expect(h.clock.pending()).toContain(60_000);
    fail = false;
    h.triggers.forEach((t) => t("online"));
    await engine.idle();
    expect(engine.status()).toBe("idle");
    await engine.stop();
  });

  it("is silent: nothing reaches the console, whatever fails", async () => {
    const store = new FakeStore();
    store.onReplicate = () => {
      throw new CouchHttpError(500);
    };
    const h = harness({ makeStore: () => store });
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();
    await h.clock.advance(30_000, settleWith(engine));
    await engine.stop();
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it("RxDB unavailable (no store) leaves the engine unavailable and quiet", async () => {
    const h = harness({ makeStore: () => null });
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();
    expect(engine.status()).toBe("unavailable");
    expect(h.clock.pending()).toEqual([]);
    await engine.stop();
  });
});

describe("triggers", () => {
  it("a hidden page does not sync; showing it does", async () => {
    const h = harness();
    h.flags.visible = false;
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();
    expect(h.sessions.fetched).toBe(0);
    h.flags.visible = true;
    h.triggers.forEach((t) => t("focus"));
    await engine.idle();
    expect(h.stores[0].replications).toBe(1);
    await engine.stop();
  });

  it("focus within the cooldown of the last run is ignored, after it is not", async () => {
    const h = harness();
    const engine = await started(h);
    h.triggers.forEach((t) => t("focus"));
    await engine.idle();
    expect(h.stores[0].replications).toBe(1);
    await h.clock.advance(FOCUS_COOLDOWN_MS, settleWith(engine));
    h.triggers.forEach((t) => t("focus"));
    await engine.idle();
    expect(h.stores[0].replications).toBe(2);
    await engine.stop();
  });

  it("many requests while a cycle runs collapse into one more", async () => {
    const h = harness();
    const engine = await started(h);
    engine.requestSync();
    engine.requestSync();
    engine.requestSync();
    await engine.idle();
    expect(h.stores[0].replications).toBe(2);
    await engine.stop();
  });
});

describe("local changes", () => {
  it("are written after a short debounce and pushed after a longer one", async () => {
    const h = harness();
    const engine = await started(h);
    h.bridge.change({ selectedActivities: ["livestock"] });
    expect(h.stores[0].upserts).toEqual([]);
    await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, settleWith(engine));
    expect(h.stores[0].upserts).toEqual(["activity:livestock"]);
    expect(h.stores[0].replications).toBe(1);
    await h.clock.advance(PUSH_DEBOUNCE_MS, settleWith(engine));
    expect(h.stores[0].replications).toBe(2);
    await engine.stop();
  });

  it("a burst of changes is one write", async () => {
    const h = harness();
    const engine = await started(h);
    h.bridge.change({ theme: "dark" });
    h.bridge.change({ theme: "light" });
    h.bridge.change({ theme: "dark" });
    await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, settleWith(engine));
    expect(h.stores[0].upserts).toEqual(["preference:theme"]);
    expect((await h.stores[0].liveDocs())[0].preferenceValue).toBe("dark");
    await engine.stop();
  });

  it("unselecting an activity that has a document deletes it", async () => {
    const h = harness();
    const engine = await started(h);
    h.bridge.change({ selectedActivities: ["livestock"] });
    await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, settleWith(engine));
    h.bridge.change({ selectedActivities: [] });
    await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, settleWith(engine));
    expect(h.stores[0].tombstones).toEqual(["activity:livestock"]);
    await engine.stop();
  });

  it("an edit made offline waits in the local database and goes out on the next cycle", async () => {
    const store = new FakeStore();
    const h = harness({ makeStore: () => store });
    const engine = await started(h);
    h.flags.online = false;
    h.bridge.change({ theme: "dark" });
    await h.clock.advance(
      LOCAL_WRITE_DEBOUNCE_MS + PUSH_DEBOUNCE_MS,
      settleWith(engine),
    );
    expect(store.upserts).toEqual(["preference:theme"]);
    const before = store.replications;
    h.flags.online = true;
    h.triggers.forEach((t) => t("online"));
    await engine.idle();
    expect(store.replications).toBe(before + 1);
    await engine.stop();
  });

  it("applying a remote change to the app does not write it back", async () => {
    const store = new FakeStore();
    const h = harness({ makeStore: () => store });
    store.onReplicate = async (n) => {
      if (n === 1) {
        // Another device's theme arrives with the pull.
        await store.upsert({
          id: "preference:theme",
          type: "preference",
          schemaVersion: 1,
          ownerPersonId: PERSON,
          deviceId: "22222222-2222-4222-8222-222222222222",
          createdAt: "2026-11-02T09:00:00.000Z",
          updatedAt: "2026-11-02T09:00:00.000Z",
          preferenceKey: "theme",
          preferenceValue: "dark",
        });
        store.upserts.length = 0; // only count what THIS device writes
      }
    };
    const engine = await started(h);
    expect(h.bridge.state.theme).toBe("dark");
    expect(h.bridge.applied).toEqual([{ theme: "dark" }]);
    await h.clock.advance(
      LOCAL_WRITE_DEBOUNCE_MS + PUSH_DEBOUNCE_MS,
      settleWith(engine),
    );
    expect(store.upserts).toEqual([]);
    await engine.stop();
  });

  it("a change made while the documents are read is not overwritten", async () => {
    const store = new FakeStore();
    const h = harness({ makeStore: () => store });
    store.onReplicate = async (n) => {
      if (n === 1) {
        await store.upsert({
          id: "activity:old",
          type: "activity",
          schemaVersion: 1,
          ownerPersonId: PERSON,
          deviceId: "22222222-2222-4222-8222-222222222222",
          createdAt: "2026-11-02T09:00:00.000Z",
          updatedAt: "2026-11-02T09:00:00.000Z",
          activityId: "old",
        });
        // The person selects something while the pull is landing.
        h.bridge.change({ selectedActivities: ["livestock"] });
      }
    };
    const engine = await started(h);
    // Both survive: the remote one is applied, the local one was flushed first.
    expect([...h.bridge.state.selectedActivities].sort()).toEqual([
      "livestock",
      "old",
    ]);
    await engine.stop();
  });
});

describe("stop", () => {
  it("cancels every timer, unsubscribes and closes the store", async () => {
    const h = harness();
    const engine = await started(h);
    h.bridge.change({ theme: "dark" });
    expect(h.clock.timerCount).toBeGreaterThan(0);
    expect(h.bridge.listenerCount).toBe(1);
    expect(h.triggers.size).toBe(1);
    await engine.stop();
    expect(h.clock.timerCount).toBe(0);
    expect(h.bridge.listenerCount).toBe(0);
    expect(h.triggers.size).toBe(0);
    expect(h.stores[0].closed).toBe(true);
    expect(engine.status()).toBe("stopped");
  });

  it("makes no request after it, however much time passes or events arrive", async () => {
    const h = harness();
    const engine = await started(h);
    await engine.stop();
    const fetched = h.sessions.fetched;
    const replications = h.stores[0].replications;
    await h.clock.advance(60 * 60_000, async () => undefined);
    h.triggers.forEach((t) => t("online"));
    engine.requestSync();
    await engine.idle();
    expect(h.sessions.fetched).toBe(fetched);
    expect(h.stores[0].replications).toBe(replications);
  });

  it("drops the credential: starting again asks for a new one", async () => {
    const h = harness();
    const engine = await started(h);
    await engine.stop();
    await engine.start();
    await engine.idle();
    expect(h.sessions.fetched).toBe(2);
    await engine.stop();
  });

  it("is safe to call twice", async () => {
    const h = harness();
    const engine = await started(h);
    await engine.stop();
    await expect(engine.stop()).resolves.toBeUndefined();
  });
});

describe("a different person", () => {
  it("gets their own store; the previous person's is closed", async () => {
    let n = 0;
    const h = harness({
      session: async (_i, now) =>
        session({
          now,
          personId: n++ === 0 ? PERSON : "0190ffff-aaaa-7bbb-8ccc-0123456789ab",
          ttlMs: 90_000,
        }),
    });
    const engine = await started(h);
    expect(h.stores).toHaveLength(1);
    // The credential lapses; the next session names someone else.
    await h.clock.advance(POLL_INTERVAL_MS + 40_000, settleWith(engine));
    expect(h.stores).toHaveLength(2);
    expect(h.stores[0].closed).toBe(true);
    await engine.stop();
  });
});
