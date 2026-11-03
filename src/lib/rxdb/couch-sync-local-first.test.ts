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
  schemaVersion: 1,
  ownerPersonId: PERSON,
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
      ownerPersonId: PERSON,
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
  it("is recorded the moment it is made, and the record is cleared once it is written", async () => {
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
