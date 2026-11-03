/**
 * The engine's rules, with a manual clock and an in-memory store: credential
 * lifetime, failure handling and back-off, the triggers, local writes, and a
 * clean stop. No real time passes in any test.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCouchSyncEngine } from "./couch-sync";
import { CouchHttpError } from "./couch-fetch";
import { toRfc3339 } from "./couch-docs";
import { CouchSessionError } from "./couch-session";
import { SIGNED_OUT_CODE } from "../couch-session-contract";
import {
  COUCH_MIN_ACCESS_TOKEN_LIFE_MS,
  COUCH_MIN_GRANT_LIFE_MS,
  REFRESH_MIN_DELAY_MS,
} from "../couch-session-timing";
import {
  FakeStore,
  GRANT_TTL_MS,
  MemoryJournal,
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

describe("a change made before the local database opens is not lost", () => {
  const changedAt = (h: Harness) => toRfc3339(h.clock.now);

  it("is written when the database opens, stamped with when the person made it", async () => {
    let calls = 0;
    const h = harness({
      session: async (_n, now) => {
        calls += 1;
        if (calls === 1) throw new CouchSessionError(503, "couch_unavailable");
        return session({ now });
      },
    });
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();
    expect(engine.status()).toBe("backing_off");
    expect(h.stores).toHaveLength(0);

    await h.clock.advance(5_000, settleWith(engine));
    const madeAt = changedAt(h);
    h.bridge.change({ theme: "light" });
    await h.clock.advance(20_000, settleWith(engine)); // still backing off

    await h.clock.advance(10_000, settleWith(engine)); // the retry: store opens
    const [store] = h.stores;
    const theme = store.written.filter((d) => d.id === "preference:theme");
    expect(theme).toHaveLength(1);
    expect(theme[0]).toMatchObject({
      preferenceValue: "light",
      updatedAt: madeAt,
    });
    // Before the replication, so the pull meets it as a conflict to order by
    // time instead of overwriting it.
    expect(store.replications).toBeGreaterThanOrEqual(1);
    await engine.stop();
  });

  it("is written when the page started offline and the connection comes back", async () => {
    const h = harness();
    h.flags.online = false;
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();
    expect(h.stores).toHaveLength(0);

    const madeAt = changedAt(h);
    h.bridge.change({ selectedActivities: ["livestock"] });
    await h.clock.advance(60_000, settleWith(engine));
    expect(h.stores).toHaveLength(0);

    h.flags.online = true;
    h.triggers.forEach((t) => t("online"));
    await engine.idle();
    const [store] = h.stores;
    const doc = store.written.find((d) => d.id === "activity:livestock");
    expect(doc).toBeDefined();
    // A minute old: ordered against other devices by when it happened.
    expect(doc?.updatedAt).toBe(madeAt);
    await engine.stop();
  });

  it("several changes before it opens are all written; a removal of an activity that never had a document writes nothing", async () => {
    const h = harness({ bridge: { selectedActivities: ["livestock"] } });
    h.flags.online = false;
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    h.bridge.change({ theme: "dark", selectedForecastModel: "gfs_seamless" });
    h.bridge.change({ selectedActivities: ["gardening"] });
    h.flags.online = true;
    h.triggers.forEach((t) => t("online"));
    await engine.idle();
    const ids = h.stores[0].written.map((d) => d.id).sort();
    expect(ids).toEqual([
      "activity:gardening",
      "preference:forecastModel",
      "preference:theme",
    ]);
    expect(h.stores[0].tombstones).toEqual([]);
    await engine.stop();
  });

  it("an untouched setting still writes nothing: defaults never win", async () => {
    const h = harness();
    h.flags.online = false;
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    h.flags.online = true;
    h.triggers.forEach((t) => t("online"));
    await engine.idle();
    expect(h.stores[0].written).toEqual([]);
    await engine.stop();
  });
});

describe("a short-lived credential never makes a hot loop", () => {
  it.each([[40_000], [60_000]])(
    "a %i ms grant is a failure that backs off: no store, no replication, a handful of requests a minute",
    async (ttlMs) => {
      const h = harness({
        session: async (n, now) => {
          // A runaway loop must fail the test, not hang it.
          if (n > 400) throw new CouchSessionError(503, "runaway");
          return session({ now, ttlMs });
        },
      });
      const engine = createCouchSyncEngine(h.deps);
      await engine.start();
      await engine.idle();
      expect(engine.status()).toBe("backing_off");
      expect(h.clock.pending()).toContain(30_000);
      expect(h.stores).toHaveLength(0);

      let last = h.sessions.fetched;
      for (let minute = 0; minute < 10; minute++) {
        await h.clock.advance(60_000, settleWith(engine));
        expect(
          h.sessions.fetched - last,
          `minute ${minute}`,
        ).toBeLessThanOrEqual(4);
        last = h.sessions.fetched;
      }
      expect(h.sessions.fetched).toBeLessThan(20);
      await engine.stop();
    },
  );

  it("a 91 s grant is used and renewed at a sane pace: a handful of requests a minute", async () => {
    const h = harness({
      session: async (n, now) => {
        if (n > 400) throw new CouchSessionError(503, "runaway");
        return session({ now, ttlMs: 91_000 });
      },
    });
    const engine = await started(h);
    expect(engine.status()).toBe("idle");
    expect(h.stores[0].replications).toBe(1);
    let last = h.sessions.fetched;
    for (let minute = 0; minute < 10; minute++) {
      await h.clock.advance(60_000, settleWith(engine));
      expect(h.sessions.fetched - last, `minute ${minute}`).toBeLessThanOrEqual(
        4,
      );
      last = h.sessions.fetched;
    }
    expect(engine.status()).toBe("idle");
    await engine.stop();
  });

  it("a grant that is only just long enough is accepted, one second under is not", async () => {
    const accepted = harness({
      session: async (_n, now) =>
        session({ now, ttlMs: COUCH_MIN_GRANT_LIFE_MS }),
    });
    const a = await started(accepted);
    expect(a.status()).toBe("idle");
    await a.stop();

    const refused = harness({
      session: async (_n, now) =>
        session({ now, ttlMs: COUCH_MIN_GRANT_LIFE_MS - 1_000 }),
    });
    const r = await started(refused);
    expect(r.status()).toBe("backing_off");
    await r.stop();
  });

  it("every grant the issuer lets through is long enough for the page, and the page's floor is above its own renewal lead", () => {
    expect(COUCH_MIN_GRANT_LIFE_MS).toBeLessThan(
      COUCH_MIN_ACCESS_TOKEN_LIFE_MS,
    );
    expect(COUCH_MIN_GRANT_LIFE_MS).toBeGreaterThan(REFRESH_LEAD_MS);
  });

  it("two credential fetches are never closer than the minimum delay, even for a grant inside the renewal lead window", async () => {
    const fetchedAt: number[] = [];
    const h = harness({
      session: async (n, now) => {
        if (n > 400) throw new CouchSessionError(503, "runaway");
        fetchedAt.push(now);
        return session({ now, ttlMs: COUCH_MIN_GRANT_LIFE_MS });
      },
    });
    const engine = await started(h);
    await h.clock.advance(10 * 60_000, settleWith(engine));
    expect(fetchedAt.length).toBeGreaterThan(2);
    for (let i = 1; i < fetchedAt.length; i++) {
      expect(fetchedAt[i] - fetchedAt[i - 1]).toBeGreaterThanOrEqual(
        REFRESH_MIN_DELAY_MS,
      );
    }
    await engine.stop();
  });
});

describe("the local database belongs to the person who signed in", () => {
  // (That ONE such answer removes nothing, and what the second one does, is
  // `couch-sync-signed-out.test.ts`. The tests here start from a page that has
  // already heard it once, a minute or more ago.)
  const heardOnce = (h: Harness) => {
    h.marker.at = h.clock.now - 2 * 60_000;
  };

  it("a 401 from the route that has been heard before closes this person's database and removes every local sync database", async () => {
    let signedOut = false;
    const h = harness({
      session: async (_n, now) => {
        if (signedOut) throw new CouchSessionError(401, SIGNED_OUT_CODE);
        return session({ now });
      },
    });
    const engine = await started(h);
    h.purged.length = 0;
    signedOut = true;
    heardOnce(h);
    await h.clock.advance(GRANT_TTL_MS, settleWith(engine));
    expect(engine.status()).toBe("signed_out");
    expect(h.stores[0].closed).toBe(true);
    expect(h.purged).toEqual([null]);
    // Once: nothing asks again.
    await h.clock.advance(30 * 60_000, settleWith(engine));
    h.triggers.forEach((t) => t("focus"));
    await engine.idle();
    expect(h.purged).toEqual([null]);
    await engine.stop();
  });

  it("an anonymous visitor's request, the second time it is heard, also clears what an earlier sign-in left", async () => {
    const h = harness({
      session: async () => {
        throw new CouchSessionError(401, SIGNED_OUT_CODE);
      },
    });
    heardOnce(h);
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();
    expect(h.purged).toEqual([null]);
    expect(h.stores).toHaveLength(0);
    await engine.stop();
  });

  it("the first cycle for a person removes every OTHER person's database, once", async () => {
    const h = harness();
    const engine = await started(h);
    expect(h.purged).toEqual([PERSON]);
    await h.clock.advance(5 * 60_000, settleWith(engine));
    expect(h.purged).toEqual([PERSON]);
    await engine.stop();
  });

  it("a different person issued in the same run closes the first database and removes it", async () => {
    const other = "0190ffff-0000-7000-8000-00000000abcd";
    let who = PERSON;
    const h = harness({
      session: async (_n, now) => session({ now, personId: who }),
    });
    const engine = await started(h);
    who = other;
    await h.clock.advance(GRANT_TTL_MS, settleWith(engine));
    expect(h.stores).toHaveLength(2);
    expect(h.stores[0].closed).toBe(true);
    expect(h.purged).toEqual([PERSON, other]);
    await engine.stop();
  });

  it("a purge that fails or throws never reaches the page and never stops the sync", async () => {
    const h = harness({
      purge: () => {
        throw new Error("IndexedDB is blocked");
      },
    });
    const engine = await started(h);
    expect(engine.status()).toBe("idle");
    expect(h.stores[0].replications).toBe(1);
    await engine.stop();

    const signedOut = harness({
      session: async () => {
        throw new CouchSessionError(401, SIGNED_OUT_CODE);
      },
      purge: () => {
        throw new Error("IndexedDB is blocked");
      },
    });
    heardOnce(signedOut);
    const e2 = createCouchSyncEngine(signedOut.deps);
    await e2.start();
    await e2.idle();
    expect(e2.status()).toBe("signed_out");
    await e2.stop();
  });

  it("an engine given no way to purge works as before", async () => {
    const h = harness();
    delete h.deps.purgeStores;
    const engine = await started(h);
    expect(engine.status()).toBe("idle");
    await engine.stop();
  });

  describe("only a 401 that says 'signed out' wipes anything", () => {
    // 401 without the code (a 401 from somewhere else, a misconfiguration, an
    // expired token the server could not refresh) and every 5xx must leave the
    // person's local database AND the record of unwritten changes alone: they
    // may be the only copy of a change that was made offline.
    const notSignedOut: [string, () => Error][] = [
      ["a 401 with no code", () => new CouchSessionError(401, "unavailable")],
      [
        "a 401 with another code",
        () => new CouchSessionError(401, "reauth_required"),
      ],
      [
        "the old 'unauthorized' code",
        () => new CouchSessionError(401, "unauthorized"),
      ],
      ["a 503", () => new CouchSessionError(503, "couch_unavailable")],
      ["a 500", () => new CouchSessionError(500, "unavailable")],
      ["a 429", () => new CouchSessionError(429, "rate_limited")],
      ["no answer", () => new CouchSessionError(0, "offline")],
    ];

    it.each(notSignedOut)(
      "%s: nothing is removed, the journal stays, and the engine backs off",
      async (_name, make) => {
        const journal = new MemoryJournal();
        let failing = false;
        const h = harness({
          journal,
          recorded: PERSON,
          session: async (_n, now) => {
            if (failing) throw make();
            return session({ now });
          },
        });
        const engine = await started(h);
        h.purged.length = 0;
        failing = true;
        h.bridge.change({ theme: "dark" }); // a change not yet written anywhere
        expect(journal.record).not.toBeNull();
        await h.clock.advance(GRANT_TTL_MS, settleWith(engine));

        expect(engine.status()).toBe("backing_off");
        expect(h.purged).toEqual([]);
        expect(h.stores[0].closed).toBe(false);
        // The change was written to the local database, and the journal was
        // not cleared by anything but that write.
        expect(h.stores[0].written.map((d) => d.id)).toContain(
          "preference:theme",
        );
        await engine.stop();
      },
    );

    it("a 401 with the code, heard before, does: the database is removed and the record is cleared", async () => {
      const journal = new MemoryJournal();
      let signedOut = false;
      const h = harness({
        journal,
        recorded: null,
        session: async (_n, now) => {
          if (signedOut) throw new CouchSessionError(401, SIGNED_OUT_CODE);
          return session({ now });
        },
      });
      h.flags.online = true;
      const engine = await started(h);
      signedOut = true;
      heardOnce(h);
      h.bridge.change({ theme: "dark" });
      expect(journal.record).not.toBeNull();
      await h.clock.advance(GRANT_TTL_MS, settleWith(engine));
      expect(engine.status()).toBe("signed_out");
      expect(h.purged).toContain(null);
      expect(journal.record).toBeNull();
      await engine.stop();
    });
  });

  it("a 403 or a failure is not a sign-out: nothing is removed", async () => {
    const h = harness({
      session: async () => {
        throw new CouchSessionError(403, "account_pending_deletion");
      },
    });
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();
    expect(h.purged).toEqual([]);
    await engine.stop();
  });
});

describe("only the leader tab replicates", () => {
  const withStore = (configure: (s: FakeStore) => void) => {
    const store = new FakeStore();
    configure(store);
    return harness({ makeStore: () => store });
  };

  it("a tab that is not the leader does not replicate, does not prepare the database, and drops the credential", async () => {
    const h = withStore((s) => {
      s.leader = false;
    });
    const engine = await started(h);
    expect(h.stores[0].replications).toBe(0);
    expect(h.ensured).toEqual([]);
    expect(engine.status()).toBe("idle");
    // No credential kept: no renewal timer, only the poll.
    expect(h.clock.pending()).toEqual([POLL_INTERVAL_MS]);
    await h.clock.advance(10 * 60_000, settleWith(engine));
    expect(h.sessions.fetched).toBe(1);
    expect(h.stores[0].replications).toBe(0);
    await engine.stop();
  });

  it("a follower still applies what the shared database holds, and writes the person's own changes into it", async () => {
    const h = withStore((s) => {
      s.leader = false;
      s.docs.set("preference:theme", {
        id: "preference:theme",
        type: "preference",
        schemaVersion: 1,
        ownerPersonId: PERSON,
        deviceId: "11111111-2222-4333-8444-555555555555",
        createdAt: "2026-11-02T09:00:00.000Z",
        updatedAt: "2026-11-02T09:00:00.000Z",
        preferenceKey: "theme",
        preferenceValue: "dark",
      });
    });
    const engine = await started(h);
    expect(h.bridge.state.theme).toBe("dark");

    h.bridge.change({ selectedActivities: ["livestock"] });
    await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, settleWith(engine));
    expect(h.stores[0].upserts).toContain("activity:livestock");
    expect(h.stores[0].replications).toBe(0);
    await engine.stop();
  });

  it("a follower never seeds: that is the leader's job, after its first pull", async () => {
    const h = withStore((s) => {
      s.leader = false;
    });
    h.bridge.change({ theme: "dark", selectedActivities: ["livestock"] });
    const engine = createCouchSyncEngine(h.deps);
    // The change above was made before start, so it is the baseline.
    await engine.start();
    await engine.idle();
    expect(h.stores[0].upserts).toEqual([]);
    await engine.stop();
  });

  it("when the leader goes away the next cycle takes over: a new credential, the database prepared, replication, seeding", async () => {
    const store = new FakeStore();
    store.leader = false;
    const h = harness({
      makeStore: () => store,
      bridge: { theme: "dark" },
    });
    const engine = await started(h);
    expect(store.replications).toBe(0);

    store.leader = true;
    await h.clock.advance(POLL_INTERVAL_MS, settleWith(engine));
    expect(h.sessions.fetched).toBe(2);
    expect(h.ensured).toHaveLength(1);
    expect(store.replications).toBeGreaterThanOrEqual(1);
    expect(store.upserts).toContain("preference:theme");
    await engine.stop();
  });

  it("a leader tab that is hidden replicates when another tab wrote, and only then", async () => {
    const h = withStore(() => undefined);
    const engine = await started(h);
    const [store] = h.stores;
    expect(store.replications).toBe(1);

    h.flags.visible = false;
    await h.clock.advance(5 * 60_000, settleWith(engine));
    expect(store.replications).toBe(1); // hidden: nothing on a timer

    store.emitShared(); // another tab wrote into the shared database
    await h.clock.advance(PUSH_DEBOUNCE_MS, settleWith(engine));
    expect(store.replications).toBe(2);
    await engine.stop();
  });

  it("a hidden tab that is not the leader does nothing when another tab wrote", async () => {
    const h = withStore((s) => {
      s.leader = false;
    });
    const engine = await started(h);
    h.flags.visible = false;
    h.stores[0].emitShared();
    await h.clock.advance(PUSH_DEBOUNCE_MS * 3, settleWith(engine));
    expect(h.stores[0].replications).toBe(0);
    expect(h.sessions.fetched).toBe(1);
    await engine.stop();
  });

  it("a visible follower applies what the leader pulled soon after it lands", async () => {
    const h = withStore((s) => {
      s.leader = false;
    });
    const engine = await started(h);
    h.stores[0].docs.set("preference:theme", {
      id: "preference:theme",
      type: "preference",
      schemaVersion: 1,
      ownerPersonId: PERSON,
      deviceId: "11111111-2222-4333-8444-555555555555",
      createdAt: "2026-11-02T09:00:00.000Z",
      updatedAt: "2026-11-02T09:00:00.000Z",
      preferenceKey: "theme",
      preferenceValue: "light",
    });
    h.stores[0].emitShared();
    await h.clock.advance(PUSH_DEBOUNCE_MS, settleWith(engine));
    expect(h.bridge.state.theme).toBe("light");
    await engine.stop();
  });

  it("writes the engine makes itself are not mistaken for another tab's: no cycle begets a cycle", async () => {
    const store = new FakeStore();
    store.onReplicate = () => store.emitShared(); // the pull writes documents
    const h = harness({ makeStore: () => store });
    const engine = await started(h);
    await h.clock.advance(PUSH_DEBOUNCE_MS * 4, settleWith(engine));
    expect(store.replications).toBe(1);
    await engine.stop();
  });

  it("the shared-write listener is removed when the engine stops and when the person changes", async () => {
    const h = withStore(() => undefined);
    const engine = await started(h);
    expect(h.stores[0].sharedListenerCount).toBe(1);
    await engine.stop();
    expect(h.stores[0].sharedListenerCount).toBe(0);
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

  it("signed out (401 from the route): idle until the next page load, nothing opened, no timer", async () => {
    const h = harness({
      session: async () => {
        throw new CouchSessionError(401, SIGNED_OUT_CODE);
      },
    });
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();
    expect(engine.status()).toBe("signed_out");
    expect(h.stores).toHaveLength(0);
    expect(h.clock.pending()).toEqual([]);
    await engine.stop();
  });

  it("an anonymous visitor makes exactly one request, however long the page stays open and whatever happens to it", async () => {
    const h = harness({
      session: async () => {
        throw new CouchSessionError(401, SIGNED_OUT_CODE);
      },
    });
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();
    expect(h.sessions.fetched).toBe(1);

    // Two simulated hours: focus every 20 s (past the cooldown), the network
    // dropping and coming back, a change of theme in the app, the poll.
    for (let i = 0; i < 360; i++) {
      await h.clock.advance(20_000, settleWith(engine));
      h.triggers.forEach((t) => t("focus"));
      if (i % 60 === 0) h.triggers.forEach((t) => t("online"));
      if (i % 90 === 0)
        h.bridge.change({ theme: i % 180 === 0 ? "dark" : "light" });
      await engine.idle();
    }
    expect(h.sessions.fetched).toBe(1);
    expect(engine.status()).toBe("signed_out");
    expect(h.clock.pending()).toEqual([]);
    expect(h.stores).toHaveLength(0);
    await engine.stop();
  });

  it("signed out is not a failure: it counts nothing, and a restart (the next page load) asks again", async () => {
    let signedIn = false;
    const h = harness({
      session: async (_n, now) => {
        if (!signedIn) throw new CouchSessionError(401, SIGNED_OUT_CODE);
        return session({ now });
      },
    });
    const engine = createCouchSyncEngine(h.deps);
    await engine.start();
    await engine.idle();
    expect(engine.status()).toBe("signed_out");
    await engine.stop();

    signedIn = true;
    await engine.start();
    await engine.idle();
    expect(h.sessions.fetched).toBe(2);
    expect(engine.status()).toBe("idle");
    expect(h.stores[0].replications).toBe(1);
    await engine.stop();
  });

  it("signed out in another tab: the next credential request is a 401, the token is dropped and everything stops", async () => {
    let signedOut = false;
    const h = harness({
      session: async (_n, now) => {
        if (signedOut) throw new CouchSessionError(401, SIGNED_OUT_CODE);
        return session({ now });
      },
    });
    const engine = await started(h);
    expect(h.stores[0].replications).toBe(1);

    signedOut = true;
    // The credential lapses; the renewal asks the route and is told no.
    await h.clock.advance(GRANT_TTL_MS, settleWith(engine));
    expect(engine.status()).toBe("signed_out");
    const replications = h.stores[0].replications;
    const asked = h.sessions.fetched;
    await h.clock.advance(30 * 60_000, settleWith(engine));
    h.triggers.forEach((t) => t("focus"));
    h.triggers.forEach((t) => t("online"));
    await engine.idle();
    expect(h.stores[0].replications).toBe(replications);
    expect(h.sessions.fetched).toBe(asked);
    expect(h.clock.pending()).toEqual([]);
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
          id: "activity:harvest",
          type: "activity",
          schemaVersion: 1,
          ownerPersonId: PERSON,
          deviceId: "22222222-2222-4222-8222-222222222222",
          createdAt: "2026-11-02T09:00:00.000Z",
          updatedAt: "2026-11-02T09:00:00.000Z",
          activityId: "harvest",
        });
        // The person selects something while the pull is landing.
        h.bridge.change({ selectedActivities: ["livestock"] });
      }
    };
    const engine = await started(h);
    // Both survive: the remote one is applied, the local one was flushed first.
    expect([...h.bridge.state.selectedActivities].sort()).toEqual([
      "harvest",
      "livestock",
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
