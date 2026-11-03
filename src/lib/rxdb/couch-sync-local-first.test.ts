/**
 * Offline first, in the engine: the local database opens at start() with no
 * network and no credential, a change is written to it as soon as the debounce
 * ends (and when the page goes away), and a change that cannot be written yet is
 * kept in a record that survives the page, so a person's choice is never only
 * in memory. Also: a change made while the first replication runs, and a tab
 * that is not the leader never asking for a credential.
 *
 * The engine is driven with a manual clock and an in-memory store; the same
 * scenarios against real RxDB and a fake CouchDB are in
 * `couch-sync-e2e.test.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createCouchSyncEngine } from "./couch-sync";
import { toRfc3339 } from "./couch-docs";
import { CouchHttpError } from "./couch-fetch";
import {
  FakeStore,
  MemoryJournal,
  PERSON,
  START,
  harness,
  session,
  type Harness,
} from "./test-support/couch-engine-harness";
import { LOCAL_WRITE_DEBOUNCE_MS, POLL_INTERVAL_MS } from "./couch-schedule";

const engines: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  while (engines.length) await engines.pop()?.stop();
});

async function begin(h: Harness) {
  const engine = createCouchSyncEngine(h.deps);
  engines.push(engine);
  await engine.start();
  await engine.idle();
  return engine;
}

const settleWith = (engine: { idle(): Promise<void> }) => () => engine.idle();

const themeDoc = (value: string, updatedAt: string) => ({
  id: "preference:theme",
  type: "preference" as const,
  schemaVersion: "v3.1",
  deviceId: "99999999-2222-4333-8444-555555555555",
  createdAt: updatedAt,
  updatedAt,
  preferenceKey: "theme" as const,
  preferenceValue: value,
});

describe("the local database opens at start, before any credential", () => {
  it("a browser that already holds the person's database opens it offline: no credential, no replication", async () => {
    const h = harness({ recorded: PERSON });
    h.flags.online = false;
    await begin(h);
    expect(h.stores).toHaveLength(1);
    expect(h.sessions.fetched).toBe(0);
    expect(h.stores[0].replications).toBe(0);
  });

  it("a change made offline is written to it after the debounce, stamped with when it was made", async () => {
    const h = harness({ recorded: PERSON });
    h.flags.online = false;
    const engine = await begin(h);

    const madeAt = h.clock.now;
    h.bridge.change({ theme: "light" });
    await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, settleWith(engine));

    const [store] = h.stores;
    expect(store.written).toHaveLength(1);
    expect(store.written[0]).toMatchObject({
      id: "preference:theme",
      preferenceValue: "light",
      updatedAt: toRfc3339(madeAt),
    });
    expect(h.sessions.fetched).toBe(0);
  });

  it("a browser with no database yet (a person's first session) opens it when the first credential arrives, as before", async () => {
    const h = harness({ recorded: null });
    await begin(h);
    expect(h.sessions.fetched).toBe(1);
    expect(h.stores).toHaveLength(1);
  });

  it("a database that cannot be opened at start is tried again by the cycle, which marks sync unavailable only if that fails too", async () => {
    let opens = 0;
    const h = harness({
      recorded: PERSON,
      makeStore: () => {
        opens += 1;
        return null;
      },
    });
    const engine = await begin(h);
    expect(opens).toBe(2); // once at start, once by the first cycle
    expect(engine.status()).toBe("unavailable");
  });

  it("a database opened on the record's guess that turns out to be another person's is closed; what the person changed since the page started is written to their own", async () => {
    const OTHER = "0190ffff-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    const h = harness({
      recorded: OTHER,
      // The credential names PERSON: the guess was wrong.
      session: async (_n, now) => session({ now }),
      // PERSON's own database already holds an older choice of theirs.
      makeStore: (id) => {
        const s = new FakeStore();
        if (id === PERSON) {
          s.docs.set(
            "preference:theme",
            themeDoc("dark", "2026-11-02T09:00:00.000Z"),
          );
        }
        return s;
      },
    });
    h.flags.online = false;
    const engine = await begin(h);
    expect(h.stores).toHaveLength(1); // the guess

    const madeAt = h.clock.now;
    h.bridge.change({ theme: "light" });
    await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, settleWith(engine));
    expect(h.stores[0].written).toHaveLength(1); // written to the guess

    h.flags.online = true;
    h.triggers.forEach((t) => t("online"));
    await engine.idle();
    expect(h.stores[0].closed).toBe(true);
    expect(h.stores).toHaveLength(2);
    const mine = h.stores[1].written.filter((d) => d.id === "preference:theme");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      schemaVersion: "v3.1",
      preferenceValue: "light",
    });
    // Newer than their older choice, so it wins, and the app keeps it.
    expect(mine[0].updatedAt >= toRfc3339(madeAt)).toBe(true);
    expect(h.bridge.state.theme).toBe("light");
    expect(h.purged).toContain(PERSON);
  });

  it("reload: the new page's engine, over the same database, does not write the change a second time", async () => {
    const store = new FakeStore();
    const h = harness({ recorded: PERSON, makeStore: () => store });
    h.flags.online = false;
    const first = await begin(h);
    h.bridge.change({ theme: "light" });
    await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, settleWith(first));
    await first.stop();
    expect(store.written).toHaveLength(1);

    h.clock.now += 60_000;
    await begin(h); // the same app state, the same database
    expect(store.written).toHaveLength(1);
    expect(store.written[0].updatedAt).toBe(toRfc3339(START));
  });
});

describe("a change is never only in memory", () => {
  it("is recorded the moment it is made, and the record is cleared once it is in the database a credential has confirmed", async () => {
    const journal = new MemoryJournal();
    const h = harness({ recorded: PERSON, journal });
    h.flags.online = false;
    const engine = await begin(h);
    expect(journal.record).toBeNull();

    h.bridge.change({ theme: "light" });
    // Not waiting for the debounce: the record is already there.
    expect(journal.record).toMatchObject({
      at: START,
      base: { theme: "system" },
    });

    await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, settleWith(engine));
    expect(h.stores[0].written).toHaveLength(1);
    // Written, but to the database of "the person this browser holds one for":
    // nobody has said it is this person's, so the record is not cleared yet.
    expect(journal.record).not.toBeNull();

    h.flags.online = true;
    h.triggers.forEach((t) => t("online"));
    await engine.idle();
    expect(journal.record).toBeNull();
  });

  it("first session, offline, the page closes before any database exists: the next page still writes the change, stamped with when it was made", async () => {
    const journal = new MemoryJournal();
    const h = harness({ recorded: null, journal });
    h.flags.online = false;
    const first = await begin(h);
    expect(h.stores).toHaveLength(0);

    const madeAt = h.clock.now;
    h.bridge.change({ theme: "light" });
    await first.stop(); // the page goes away; nothing was written anywhere
    expect(journal.record).not.toBeNull();

    // A minute later a new page: the app state is what the person left it as.
    h.clock.now += 60_000;
    h.flags.online = true;
    await begin(h);
    const [store] = h.stores;
    const theme = store.written.filter((d) => d.id === "preference:theme");
    expect(theme).toHaveLength(1);
    expect(theme[0]).toMatchObject({
      preferenceValue: "light",
      updatedAt: toRfc3339(madeAt),
    });
    expect(journal.record).toBeNull();
  });

  it("the same, when the credential keeps failing for the whole first page", async () => {
    const journal = new MemoryJournal();
    const h = harness({
      recorded: null,
      journal,
      session: async () => {
        throw new Error("down");
      },
    });
    const first = await begin(h);
    const madeAt = h.clock.now;
    h.bridge.change({ selectedActivities: ["livestock"] });
    await h.clock.advance(60_000, settleWith(first));
    await first.stop();

    const h2 = harness({ recorded: null, journal, bridge: h.bridge.state });
    h2.clock.now = madeAt + 600_000;
    await begin(h2);
    const doc = h2.stores[0].written.find((d) => d.id === "activity:livestock");
    expect(doc).toBeDefined();
    expect(doc?.updatedAt).toBe(toRfc3339(madeAt));
  });

  it("a change inside the debounce window is written when the page goes away (pagehide)", async () => {
    const h = harness({ recorded: PERSON });
    const engine = await begin(h);
    h.bridge.change({ theme: "dark" });
    // No time passes: the 750 ms debounce has not fired.
    await engine.stop();
    const [store] = h.stores;
    expect(store.written.map((d) => d.id)).toEqual(["preference:theme"]);
    expect(store.closed).toBe(true);
  });

  it("flush() writes at once, without waiting for the debounce (the page was hidden)", async () => {
    const h = harness({ recorded: PERSON });
    const engine = await begin(h);
    h.bridge.change({ theme: "dark" });
    await engine.flush();
    expect(h.stores[0].written.map((d) => d.id)).toEqual(["preference:theme"]);
  });

  it("an engine that wrote nothing never clears a record another tab left", async () => {
    const journal = new MemoryJournal();
    const a = harness({ recorded: PERSON, journal });
    const b = harness({ recorded: PERSON, journal });
    const engineA = await begin(a);
    const engineB = await begin(b);

    a.bridge.change({ theme: "light" }); // tab A records its change
    expect(journal.record).not.toBeNull();
    const clearsBefore = journal.clears;

    // Tab B runs a whole cycle with nothing of its own to write.
    await b.clock.advance(POLL_INTERVAL_MS, settleWith(engineB));
    expect(journal.clears).toBe(clearsBefore);
    expect(journal.record).not.toBeNull();

    await a.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, settleWith(engineA));
    expect(journal.record).toBeNull();
  });

  it("what the engine applies from the server is not a change the person made: nothing is recorded for it", async () => {
    const journal = new MemoryJournal();
    const store = new FakeStore();
    store.docs.set(
      "preference:theme",
      themeDoc("dark", "2026-11-02T09:00:00.000Z"),
    );
    const h = harness({ recorded: PERSON, makeStore: () => store, journal });
    const engine = await begin(h);
    expect(h.bridge.state.theme).toBe("dark"); // applied
    await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS * 2, settleWith(engine));
    expect(journal.writes).toBe(0);
    expect(store.written).toEqual([]);
  });

  it("a corrupt or unreadable record is ignored: the page starts from its own state", async () => {
    const journal = new MemoryJournal();
    journal.read = () => {
      throw new Error("blocked");
    };
    const h = harness({ recorded: PERSON, journal });
    const engine = await begin(h);
    expect(engine.status()).toBe("idle");
    expect(h.stores[0].written).toEqual([]);
  });

  it("a journal that cannot be written never stops the change being written to the database", async () => {
    const journal = new MemoryJournal();
    journal.write = () => {
      throw new Error("quota");
    };
    const h = harness({ recorded: PERSON, journal });
    const engine = await begin(h);
    h.bridge.change({ theme: "dark" });
    await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, settleWith(engine));
    expect(h.stores[0].written.map((d) => d.id)).toEqual(["preference:theme"]);
  });
});

describe("a change made while the first replication runs", () => {
  it("is written, and is not reverted by an older value the replication pulled", async () => {
    const store = new FakeStore();
    store.onReplicate = (n) => {
      if (n !== 1) return;
      // The pull brings another device's older choice...
      store.docs.set(
        "preference:theme",
        themeDoc("dark", "2026-11-02T09:00:00.000Z"),
      );
      // ...while the person picks light in the app.
      h.bridge.change({ theme: "light" });
    };
    const h = harness({ makeStore: () => store });
    const madeAt = h.clock.now;
    const engine = await begin(h);

    expect(h.bridge.state.theme).toBe("light");
    expect(h.bridge.applied.find((p) => p.theme !== undefined)).toBeUndefined();
    const written = store.written.filter((d) => d.id === "preference:theme");
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      preferenceValue: "light",
      updatedAt: toRfc3339(madeAt),
    });
    // And it is pushed in this cycle, not left for the poll a minute away.
    expect(store.replications).toBe(2);
    await engine.stop();
  });

  it("an activity picked during it is kept, not dropped for having no document yet", async () => {
    const store = new FakeStore();
    store.onReplicate = (n) => {
      if (n !== 1) return;
      h.bridge.change({ selectedActivities: ["livestock"] });
    };
    const h = harness({ makeStore: () => store });
    const engine = await begin(h);
    expect(h.bridge.state.selectedActivities).toEqual(["livestock"]);
    expect(store.upserts).toContain("activity:livestock");
    await engine.stop();
  });

  it("seeding writes settings that predate sync from what was already written, never from a read that includes an unwritten change", async () => {
    const store = new FakeStore();
    store.onReplicate = (n) => {
      if (n === 1) h.bridge.change({ selectedForecastModel: "gfs_seamless" });
    };
    const h = harness({ makeStore: () => store, bridge: { theme: "dark" } });
    const engine = await begin(h);
    const byId = new Map(store.written.map((d) => [d.id, d]));
    // The seed (predates sync) and the change (made during) are both there, once each.
    expect(byId.get("preference:theme")?.preferenceValue).toBe("dark");
    expect(byId.get("preference:forecastModel")).toMatchObject({
      preferenceValue: "gfs_seamless",
      updatedAt: toRfc3339(START),
    });
    expect(store.written).toHaveLength(2);
    await engine.stop();
  });
});

describe("a missing document is not a removal", () => {
  // The activities a person selected before sync existed have no document until
  // the leader's first cycle seeds them. A follower (or any cycle that applies
  // the documents before they exist) must not read "no document" as "another
  // device removed it" and erase the person's choices.
  it("a follower whose shared database is still empty keeps the person's activities and settings", async () => {
    const store = new FakeStore();
    store.leader = false;
    const h = harness({
      recorded: PERSON,
      makeStore: () => store,
      bridge: {
        theme: "dark",
        selectedActivities: ["livestock", "gardening", "crop-farming"],
      },
    });
    const engine = await begin(h);
    await h.clock.advance(POLL_INTERVAL_MS * 3, settleWith(engine));
    expect(h.bridge.state.selectedActivities).toEqual([
      "livestock",
      "gardening",
      "crop-farming",
    ]);
    expect(h.bridge.state.theme).toBe("dark");
    expect(h.bridge.applied).toEqual([]);
  });

  it("the leader's first cycle seeds them, and a later empty read of the database removes nothing either", async () => {
    const h = harness({
      bridge: { selectedActivities: ["livestock", "gardening"] },
    });
    const engine = await begin(h);
    expect(h.stores[0].upserts.sort()).toEqual([
      "activity:gardening",
      "activity:livestock",
    ]);
    expect(h.bridge.state.selectedActivities).toEqual([
      "livestock",
      "gardening",
    ]);
    // The local database is wiped under the running page (cleared site data):
    // the person still has their activities.
    h.stores[0].docs.clear();
    await h.clock.advance(POLL_INTERVAL_MS, settleWith(engine));
    expect(h.bridge.state.selectedActivities).toEqual([
      "livestock",
      "gardening",
    ]);
  });

  it("a deletion that was pulled (a tombstone in the database) does remove it, and only that one", async () => {
    // The leader's cycle: the credential has said whose database this is.
    const store = new FakeStore();
    store.deleted.add("activity:gardening");
    const h = harness({
      recorded: PERSON,
      makeStore: () => store,
      bridge: { selectedActivities: ["livestock", "gardening"] },
    });
    await begin(h);
    expect(h.bridge.state.selectedActivities).toEqual(["livestock"]);
  });

  it("but a tombstone in a database nobody has confirmed is the person's yet is not read as their removal: a follower (no credential) removes nothing", async () => {
    // The follower opened the database of "the one person this browser holds
    // one for", a GUESS: after a sign-out and another person's sign-in it is
    // the previous person's. A deletion found there says nothing about what
    // THIS person chose. (The leader tab, which does have a credential,
    // applies the removal, and the tabs share the app's preferences.)
    const store = new FakeStore();
    store.leader = false;
    store.deleted.add("activity:gardening");
    const h = harness({
      recorded: PERSON,
      makeStore: () => store,
      bridge: { selectedActivities: ["livestock", "gardening"] },
    });
    const engine = await begin(h);
    await h.clock.advance(POLL_INTERVAL_MS * 2, settleWith(engine));
    expect(h.bridge.state.selectedActivities).toEqual([
      "livestock",
      "gardening",
    ]);
    expect(h.bridge.applied).toEqual([]);
  });

  it("while a value that is there (a live document) still reaches a follower", async () => {
    const store = new FakeStore();
    store.leader = false;
    store.docs.set(
      "preference:theme",
      themeDoc("dark", "2026-11-02T09:00:00.000Z"),
    );
    const h = harness({ recorded: PERSON, makeStore: () => store });
    await begin(h);
    expect(h.bridge.state.theme).toBe("dark");
  });
});

describe("a change written to a database chosen on a guess is not durable until a credential says whose it is", () => {
  // `recordedPerson` is a guess: the one person this browser holds a database
  // for. If it was the wrong person (sign-out, another person signs in), the
  // change written to it is in the wrong person's database, and the engine
  // starts again from the baseline for the right one. Until a credential names
  // the person, neither the time of the change nor the record of it may go.
  const OTHER = "0190ffff-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

  const wrongGuess = (journal: MemoryJournal) =>
    harness({
      recorded: OTHER,
      journal,
      session: async (_n, now) => session({ now }), // names PERSON
    });

  it("the guess was wrong: the record stays through the write to the wrong database, and the right database gets the change with the ORIGINAL time", async () => {
    const journal = new MemoryJournal();
    const h = wrongGuess(journal);
    h.flags.online = false;
    const engine = await begin(h);

    const madeAt = h.clock.now;
    h.bridge.change({ theme: "light" });
    await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, settleWith(engine));
    expect(h.stores[0].written).toHaveLength(1); // written to the guess
    // NOT durable: the record is still there, with the state before the
    // change and the time it was made.
    expect(journal.record).toMatchObject({
      at: madeAt,
      base: { theme: "system" },
    });

    // A long time offline: the time of the change must not move.
    await h.clock.advance(10 * 60_000, settleWith(engine));
    expect(journal.record).toMatchObject({ at: madeAt });

    h.flags.online = true;
    h.triggers.forEach((t) => t("online"));
    await engine.idle();
    expect(h.stores[0].closed).toBe(true);
    const mine = h.stores[1].written.filter((d) => d.id === "preference:theme");
    expect(mine).toHaveLength(1);
    expect(mine[0].updatedAt).toBe(toRfc3339(madeAt));
    // The right database has it: now the record goes.
    expect(journal.record).toBeNull();
  });

  it("the page closes after the write to the wrong database and before any credential: the next page still has the change and its time", async () => {
    const journal = new MemoryJournal();
    const h = wrongGuess(journal);
    h.flags.online = false;
    const first = await begin(h);
    const madeAt = h.clock.now;
    h.bridge.change({ theme: "light" });
    await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, settleWith(first));
    await first.stop(); // pagehide: the only copy of the time is the record
    expect(journal.record).toMatchObject({ at: madeAt });

    h.clock.now += 2 * 60_000;
    h.flags.online = true;
    await begin(h); // a new page: the same app state, the same device
    const rightStore = h.stores.at(-1) as FakeStore;
    const mine = rightStore.written.filter((d) => d.id === "preference:theme");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      schemaVersion: "v3.1",
      preferenceValue: "light",
      updatedAt: toRfc3339(madeAt),
    });
    expect(journal.record).toBeNull();
  });

  it("the guess was right: the change is in the database the moment the debounce ends, the record stays until a credential confirms it, and then goes", async () => {
    const journal = new MemoryJournal();
    const h = harness({ recorded: PERSON, journal });
    h.flags.online = false;
    const engine = await begin(h);
    const madeAt = h.clock.now;
    h.bridge.change({ theme: "light" });
    await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, settleWith(engine));
    expect(h.stores[0].written).toHaveLength(1);
    expect(journal.record).not.toBeNull(); // offline: nobody has said whose it is

    h.flags.online = true;
    h.triggers.forEach((t) => t("online"));
    await engine.idle();
    // Same database, now confirmed: it was never written twice.
    expect(h.stores).toHaveLength(1);
    expect(
      h.stores[0].written.filter((d) => d.id === "preference:theme"),
    ).toHaveLength(1);
    expect(h.stores[0].written[0].updatedAt).toBe(toRfc3339(madeAt));
    expect(journal.record).toBeNull();
  });

  it("offline for the whole page, then reloaded: the next page rewrites the same change with the same time, and clears it once confirmed", async () => {
    const journal = new MemoryJournal();
    const store = new FakeStore();
    const h = harness({ recorded: PERSON, journal, makeStore: () => store });
    h.flags.online = false;
    const first = await begin(h);
    const madeAt = h.clock.now;
    h.bridge.change({ theme: "light" });
    await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, settleWith(first));
    await first.stop();

    h.clock.now += 60_000;
    h.flags.online = true;
    await begin(h);
    const themeWrites = store.written.filter(
      (d) => d.id === "preference:theme",
    );
    expect(themeWrites.length).toBeGreaterThanOrEqual(1);
    for (const d of themeWrites) expect(d.updatedAt).toBe(toRfc3339(madeAt));
    expect(journal.record).toBeNull();
  });

  it("a second change before any credential keeps the state the FIRST one started from, and the latest time", async () => {
    const journal = new MemoryJournal();
    const h = harness({ recorded: PERSON, journal });
    h.flags.online = false;
    const engine = await begin(h);
    h.bridge.change({ theme: "light" });
    await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, settleWith(engine));
    await h.clock.advance(5_000, settleWith(engine));
    const secondAt = h.clock.now;
    h.bridge.change({ selectedForecastModel: "icon_global" });
    await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, settleWith(engine));
    expect(journal.record).toMatchObject({
      at: secondAt,
      base: { theme: "system", selectedForecastModel: "best_match" },
    });
  });

  it("a person who puts everything back as it was has nothing pending: the record goes", async () => {
    const journal = new MemoryJournal();
    const h = harness({ recorded: PERSON, journal });
    h.flags.online = false;
    const engine = await begin(h);
    h.bridge.change({ theme: "light" });
    await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, settleWith(engine));
    expect(journal.record).not.toBeNull();
    h.bridge.change({ theme: "system" });
    await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, settleWith(engine));
    expect(journal.record).toBeNull();
  });

  it("a database the credential opened (nothing was guessed) is durable at once, as before", async () => {
    const journal = new MemoryJournal();
    const h = harness({ recorded: null, journal });
    const engine = await begin(h);
    h.bridge.change({ theme: "light" });
    expect(journal.record).not.toBeNull();
    await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, settleWith(engine));
    expect(journal.record).toBeNull();
  });
});

describe("only a real change by the person is a change", () => {
  it("a notification with nothing different (a fresh array of the same activities) records nothing, stamps nothing and writes nothing", async () => {
    const journal = new MemoryJournal();
    const h = harness({
      recorded: null,
      journal,
      bridge: { selectedActivities: ["livestock", "gardening"] },
    });
    const engine = await begin(h);
    const writes = journal.writes;
    const docs = h.stores[0].written.length;
    for (let i = 0; i < 5; i++) {
      h.clock.now += 1_000;
      h.bridge.noise();
    }
    await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS * 4, settleWith(engine));
    expect(journal.writes).toBe(writes);
    expect(journal.record).toBeNull();
    expect(h.stores[0].written).toHaveLength(docs);
  });

  it("a place switch right after a value arrived from the device profile does not turn that value into the person's edit, stamped now, over a newer value in the cloud", async () => {
    const store = new FakeStore();
    const h = harness({ recorded: null, makeStore: () => store });
    const engine = await begin(h);
    // Another device set "light" half a minute from now; it is in the database.
    store.docs.set(
      "preference:theme",
      themeDoc("light", toRfc3339(h.clock.now + 30_000)),
    );
    h.clock.now += 60_000;
    // The device-profile pull says "dark", and the preferences document is
    // emitted again for the place switch that follows.
    h.bridge.changeFromElsewhere({ theme: "dark" });
    await engine.idle();
    h.bridge.noise();
    await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS * 2, settleWith(engine));
    expect(
      store.written.filter(
        (d) => d.id === "preference:theme" && d.preferenceValue === "dark",
      ),
    ).toEqual([]);
    // The documents are the truth: the cloud's value is what the app ends with.
    await h.clock.advance(POLL_INTERVAL_MS, settleWith(engine));
    expect(h.bridge.state.theme).toBe("light");
  });

  describe("a value applied from the app's own preferences store (a /v1/devices pull, another tab)", () => {
    it("is not the person's edit: nothing is recorded or written for it, and it is not stamped with now", async () => {
      const journal = new MemoryJournal();
      const h = harness({
        recorded: null,
        journal,
        bridge: { selectedActivities: ["livestock", "gardening"] },
      });
      const engine = await begin(h);
      const docs = h.stores[0].written.length;
      const writes = journal.writes;

      // The device-profile pull, for a profile with no activities.
      h.bridge.changeFromElsewhere({ selectedActivities: [] });
      await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS * 3, settleWith(engine));
      expect(journal.writes).toBe(writes);
      expect(journal.record).toBeNull();
      expect(h.stores[0].tombstones).toEqual([]); // no removal is pushed
      expect(h.stores[0].written).toHaveLength(docs);
    });

    it("the cloud's activities are not erased by it: the documents still say what they said, and come back", async () => {
      const h = harness({
        recorded: null,
        bridge: { selectedActivities: ["livestock", "gardening"] },
      });
      const engine = await begin(h);
      h.bridge.changeFromElsewhere({ selectedActivities: [] });
      await h.clock.advance(POLL_INTERVAL_MS, settleWith(engine));
      expect(h.stores[0].tombstones).toEqual([]);
      expect([...h.stores[0].docs.keys()].sort()).toEqual([
        "activity:gardening",
        "activity:livestock",
      ]);
      // The documents are the truth: the app has its activities again.
      expect(h.bridge.state.selectedActivities.sort()).toEqual([
        "gardening",
        "livestock",
      ]);
    });

    it("a later edit by the person is the person's, and is a difference from what was applied, not from what they started with", async () => {
      const h = harness({
        recorded: null,
        bridge: { selectedActivities: ["livestock"] },
      });
      const engine = await begin(h);
      h.bridge.changeFromElsewhere({ theme: "dark" });
      await h.clock.advance(5_000, settleWith(engine));
      const editedAt = h.clock.now;
      h.bridge.change({ selectedActivities: ["livestock", "gardening"] });
      await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, settleWith(engine));
      const garden = h.stores[0].written.find(
        (d) => d.id === "activity:gardening",
      );
      expect(garden?.updatedAt).toBe(toRfc3339(editedAt));
      // The applied theme was not turned into the person's edit by that write.
      expect(
        h.stores[0].written.filter((d) => d.id === "preference:theme"),
      ).toEqual([]);
    });

    it("while the person's own change is still unwritten, an applied one does not take its place", async () => {
      const journal = new MemoryJournal();
      const h = harness({ recorded: null, journal });
      const engine = await begin(h);
      const madeAt = h.clock.now;
      h.bridge.change({ theme: "light" });
      h.clock.now += 100;
      h.bridge.changeFromElsewhere({ selectedForecastModel: "icon_global" });
      expect(journal.record).toMatchObject({ at: madeAt });
      await h.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, settleWith(engine));
      const theme = h.stores[0].written.find(
        (d) => d.id === "preference:theme",
      );
      expect(theme?.updatedAt).toBe(toRfc3339(madeAt));
    });
  });
});

describe("a replication that fails after its pull still applies what it pulled", () => {
  // The plugin pulls first and pushes second. A push the server refuses (or a
  // connection that drops half way) fails the whole replication; if the cycle
  // then skipped applying, a push that keeps failing would keep every change
  // from the person's other devices off this one, with nothing but a back-off
  // to show for it.
  it("the pulled value reaches the app although the replication failed, and the cycle still backs off", async () => {
    const store = new FakeStore();
    store.onReplicate = async () => {
      store.docs.set(
        "preference:theme",
        themeDoc("dark", "2026-11-02T09:00:00.000Z"),
      );
      throw new CouchHttpError(503);
    };
    const h = harness({ recorded: PERSON, makeStore: () => store });
    const engine = await begin(h);
    expect(h.bridge.state.theme).toBe("dark");
    expect(engine.status()).toBe("backing_off");
  });

  it("a person's change made meanwhile is not overwritten by it", async () => {
    const store = new FakeStore();
    store.onReplicate = async () => {
      store.docs.set(
        "preference:theme",
        themeDoc("dark", "2026-11-02T09:00:00.000Z"),
      );
      h.bridge.change({ theme: "light" }); // the person picks light meanwhile
      throw new CouchHttpError(500);
    };
    const h = harness({ recorded: PERSON, makeStore: () => store });
    await begin(h);
    expect(h.bridge.state.theme).toBe("light");
  });

  it("nothing is applied for a run that was stopped", async () => {
    const store = new FakeStore();
    store.onReplicate = async () => {
      store.docs.set(
        "preference:theme",
        themeDoc("dark", "2026-11-02T09:00:00.000Z"),
      );
      throw new CouchHttpError(0);
    };
    const h = harness({ recorded: PERSON, makeStore: () => store });
    const engine = createCouchSyncEngine(h.deps);
    engines.push(engine);
    const starting = engine.start();
    const stopping = engine.stop();
    await Promise.all([starting, stopping]);
    expect(h.bridge.applied).toEqual([]);
  });
});

describe("a tab that is not the leader asks for no credential", () => {
  /** `tabs` pages of one browser; the first won the leader election. */
  async function browser(tabs: number, recorded: string | null) {
    const open: {
      h: Harness;
      engine: ReturnType<typeof createCouchSyncEngine>;
    }[] = [];
    for (let i = 0; i < tabs; i += 1) {
      const store = new FakeStore();
      store.leader = i === 0;
      const h = harness({ recorded, makeStore: () => store });
      open.push({ h, engine: await begin(h) });
    }
    return open;
  }
  const total = (tabs: { h: Harness }[], f: (h: Harness) => number): number =>
    tabs.reduce((n, t) => n + f(t.h), 0);

  it("four tabs on a browser that holds the database: one credential, one preparation, one replication", async () => {
    const tabs = await browser(4, PERSON);
    expect(total(tabs, (h) => h.sessions.fetched)).toBe(1);
    expect(total(tabs, (h) => h.ensured.length)).toBe(1);
    expect(total(tabs, (h) => h.stores[0].replications)).toBe(1);
    // The followers have the database open and apply what is in it.
    for (const t of tabs.slice(1)) expect(t.h.stores).toHaveLength(1);
  });

  it("and over twenty minutes: the followers still ask for nothing", async () => {
    const tabs = await browser(3, PERSON);
    for (const t of tabs) {
      await t.h.clock.advance(20 * 60_000, settleWith(t.engine));
    }
    for (const t of tabs.slice(1)) expect(t.h.sessions.fetched).toBe(0);
    // The leader renews its own, about every four minutes.
    expect(tabs[0].h.sessions.fetched).toBeGreaterThanOrEqual(1);
  });

  it("a follower that becomes the leader asks then, and only then", async () => {
    const tabs = await browser(2, PERSON);
    const { h, engine } = tabs[1];
    expect(h.sessions.fetched).toBe(0);
    h.stores[0].leader = true;
    await h.clock.advance(POLL_INTERVAL_MS, settleWith(engine));
    expect(h.sessions.fetched).toBe(1);
    expect(h.stores[0].replications).toBeGreaterThanOrEqual(1);
  });

  it("on a browser with no database yet, each tab asks once before it can know (the first session of a person), and none again", async () => {
    const tabs = await browser(3, null);
    expect(total(tabs, (h) => h.sessions.fetched)).toBe(3);
    for (const t of tabs) {
      await t.h.clock.advance(10 * 60_000, settleWith(t.engine));
    }
    for (const t of tabs.slice(1)) expect(t.h.sessions.fetched).toBe(1);
  });
});
