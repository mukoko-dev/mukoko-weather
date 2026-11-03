/**
 * One "nobody is signed in" answer never removes anything (#396).
 *
 * Removing the local copy of a person's settings, and the record of changes
 * they have not written yet, cannot be undone, and a single `401 signed_out` is
 * an inference: AuthKit can lose a session for a reason that is not a sign-out
 * (a refresh token is single-use, and two requests racing for it leave one
 * without a session). So the first answer only leaves a mark (one time, in web
 * storage) and idles; the copy is removed when a LATER page load, at least a
 * minute after the mark, hears it again. Any successful session removes the
 * mark. A different person's credential still removes the previous person's
 * database at once: that one is certain.
 *
 * Manual clock, in-memory store: no real time passes.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  SIGNED_OUT_CONFIRM_MS,
  createCouchSyncEngine,
  type SignedOutMarker,
} from "./couch-sync";
import { CouchSessionError } from "./couch-session";
import { SIGNED_OUT_CODE } from "../couch-session-contract";
import {
  MemoryJournal,
  MemorySignedOutMarker,
  PERSON,
  START,
  harness,
  session,
  type Harness,
} from "./test-support/couch-engine-harness";

const engines: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  while (engines.length) await engines.pop()?.stop();
});

/** One page load: a new engine over the same device (store, journal, mark). */
async function pageLoad(h: Harness) {
  const engine = createCouchSyncEngine(h.deps);
  engines.push(engine);
  await engine.start();
  await engine.idle();
  return engine;
}

/** The route's answer, switchable between loads. */
function route() {
  const state: { mode: "out" | "in" | "unsure" } = { mode: "out" };
  return {
    state,
    session: async (_n: number, now: number) => {
      if (state.mode === "out") {
        throw new CouchSessionError(401, SIGNED_OUT_CODE);
      }
      if (state.mode === "unsure") {
        throw new CouchSessionError(503, "couch_unavailable");
      }
      return session({ now });
    },
  };
}

describe("the first answer", () => {
  it("idles and leaves a mark, and removes nothing: no purge, the record of unwritten changes stays", async () => {
    const r = route();
    const journal = new MemoryJournal();
    const h = harness({ session: r.session, journal, recorded: PERSON });
    h.flags.online = false;
    const first = await pageLoad(h);
    h.bridge.change({ theme: "dark" }); // not written anywhere durable yet
    expect(journal.record).not.toBeNull();
    h.flags.online = true;
    h.triggers.forEach((t) => t("online"));
    await first.idle();

    expect(first.status()).toBe("signed_out");
    expect(h.marker.at).toBe(h.clock.now);
    expect(h.purged).toEqual([]); // not even purge(null)
    expect(journal.record).not.toBeNull();
    expect(journal.record?.base.theme).toBe("system");
    // The local database was opened on the record's guess; it is closed, not removed.
    expect(h.stores[0].closed).toBe(true);
    // Nothing asks again and nothing is scheduled.
    expect(h.clock.pending()).toEqual([]);
  });

  it("a person signed out in the middle of a run: the same, and the database that held their settings is kept", async () => {
    const r = route();
    r.state.mode = "in";
    const h = harness({ session: r.session });
    const engine = await pageLoad(h);
    expect(h.stores[0].replications).toBe(1);
    h.purged.length = 0;

    r.state.mode = "out";
    await h.clock.advance(300_000, () => engine.idle());
    expect(engine.status()).toBe("signed_out");
    expect(h.stores[0].closed).toBe(true);
    expect(h.purged).toEqual([]);
    expect(h.marker.at).not.toBeNull();
  });

  it("an anonymous visitor with nothing stored leaves a mark and nothing else", async () => {
    const r = route();
    const h = harness({ session: r.session });
    const engine = await pageLoad(h);
    expect(engine.status()).toBe("signed_out");
    expect(h.stores).toHaveLength(0);
    expect(h.purged).toEqual([]);
    expect(h.marker.writes).toBe(1);
  });
});

describe("the second answer, on a later page load", () => {
  it("removes the local database and the record of unwritten changes, and the mark with them", async () => {
    const r = route();
    const journal = new MemoryJournal();
    const h = harness({ session: r.session, journal, recorded: PERSON });
    h.flags.online = false;
    const first = await pageLoad(h);
    h.bridge.change({ theme: "dark" });
    h.flags.online = true;
    h.triggers.forEach((t) => t("online"));
    await first.idle();
    expect(h.purged).toEqual([]);
    await first.stop();

    h.clock.now += SIGNED_OUT_CONFIRM_MS + 1_000;
    const second = await pageLoad(h);
    expect(second.status()).toBe("signed_out");
    expect(h.purged).toEqual([null]);
    expect(journal.record).toBeNull();
    expect(h.marker.at).toBeNull();
    // The second page's database (opened on the guess) is closed too.
    expect(h.stores.at(-1)?.closed).toBe(true);
  });

  it("a second answer inside the confirmation time is still the first observation, and keeps the first time", async () => {
    const r = route();
    const h = harness({ session: r.session });
    const one = await pageLoad(h);
    const firstAt = h.marker.at;
    expect(firstAt).toBe(START);
    await one.stop();

    // A reload, or a second tab, half a minute later.
    h.clock.now += SIGNED_OUT_CONFIRM_MS / 2;
    const two = await pageLoad(h);
    expect(two.status()).toBe("signed_out");
    expect(h.purged).toEqual([]);
    expect(h.marker.at).toBe(firstAt);
    await two.stop();

    // Counted from the FIRST time, not the last: it is enough now.
    h.clock.now = (firstAt as number) + SIGNED_OUT_CONFIRM_MS;
    await pageLoad(h);
    expect(h.purged).toEqual([null]);
  });

  it("exactly at the confirmation time counts; a millisecond before it does not", async () => {
    const r = route();
    const h = harness({ session: r.session });
    await (await pageLoad(h)).stop();
    h.clock.now = START + SIGNED_OUT_CONFIRM_MS - 1;
    await (await pageLoad(h)).stop();
    expect(h.purged).toEqual([]);
    h.clock.now = START + SIGNED_OUT_CONFIRM_MS;
    await pageLoad(h);
    expect(h.purged).toEqual([null]);
  });
});

describe("anything but a signed-out answer takes the mark away, or never leaves one", () => {
  it("a successful session clears the mark, so the next 'signed out' is a first one again", async () => {
    const r = route();
    const h = harness({ session: r.session });
    await (await pageLoad(h)).stop();
    expect(h.marker.at).toBe(START);

    r.state.mode = "in";
    h.clock.now += 5 * 60_000;
    const back = await pageLoad(h);
    expect(back.status()).toBe("idle");
    expect(h.marker.at).toBeNull();
    await back.stop();

    r.state.mode = "out";
    h.clock.now += 5 * 60_000;
    const again = await pageLoad(h);
    expect(again.status()).toBe("signed_out");
    expect(h.purged.includes(null)).toBe(false); // one answer, not two
    expect(h.marker.at).toBe(h.clock.now);
  });

  it("the mark is cleared once per run, not on every renewal", async () => {
    const r = route();
    r.state.mode = "in";
    const h = harness({ session: r.session });
    h.marker.at = START - 10 * 60_000;
    const engine = await pageLoad(h);
    expect(h.marker.clears).toBe(1);
    await h.clock.advance(20 * 60_000, () => engine.idle());
    expect(h.sessions.fetched).toBeGreaterThan(3);
    expect(h.marker.clears).toBe(1);
  });

  it("an answer that is not the signed-out one (a 503, a refusal, no answer) leaves no mark and removes nothing", async () => {
    for (const make of [
      () => new CouchSessionError(503, "couch_unavailable"),
      () => new CouchSessionError(401, "unavailable"),
      () => new CouchSessionError(401, "reauth_required"),
      () => new CouchSessionError(429, "rate_limited"),
      () => new CouchSessionError(0, "offline"),
    ]) {
      const h = harness({
        session: async () => {
          throw make();
        },
        recorded: PERSON,
      });
      h.marker.at = START - 10 * 60_000; // even with an old mark
      const engine = await pageLoad(h);
      expect(engine.status()).toBe("backing_off");
      expect(h.purged).toEqual([]);
      expect(h.marker.at).toBe(START - 10 * 60_000);
      expect(h.marker.writes).toBe(0);
      await engine.stop();
    }
  });
});

describe("a different person is certain", () => {
  it("their credential removes the previous person's database at once, with no mark at all", async () => {
    const OTHER = "0190ffff-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    const h = harness({
      recorded: OTHER,
      session: async (_n, now) => session({ now }),
    });
    const engine = await pageLoad(h);
    expect(engine.status()).toBe("idle");
    expect(h.purged).toEqual([PERSON]);
    expect(h.marker.writes).toBe(0);
  });
});

describe("when the mark cannot be kept", () => {
  it("an engine with nowhere to remember the first answer never removes anything on a 401", async () => {
    const r = route();
    const h = harness({ session: r.session, recorded: PERSON });
    delete h.deps.signedOutMarker;
    await (await pageLoad(h)).stop();
    h.clock.now += 10 * 60_000;
    const later = await pageLoad(h);
    expect(later.status()).toBe("signed_out");
    expect(h.purged).toEqual([]);
  });

  it("a mark that throws on read or write is no mark: nothing is removed and nothing reaches the page", async () => {
    const r = route();
    const broken: SignedOutMarker = {
      read: () => {
        throw new Error("blocked");
      },
      write: () => {
        throw new Error("blocked");
      },
      clear: () => {
        throw new Error("blocked");
      },
    };
    const h = harness({ session: r.session, recorded: PERSON });
    h.deps.signedOutMarker = broken;
    for (let i = 0; i < 3; i++) {
      h.clock.now += 10 * 60_000;
      const engine = await pageLoad(h);
      expect(engine.status()).toBe("signed_out");
      await engine.stop();
    }
    expect(h.purged).toEqual([]);
  });

  it("a mark from the future (a clock that moved back) is not 'a minute ago': nothing is removed, and the mark is made again from now", async () => {
    const r = route();
    const h = harness({ session: r.session });
    h.marker.at = START + 60 * 60_000;
    const engine = await pageLoad(h);
    expect(engine.status()).toBe("signed_out");
    expect(h.purged).toEqual([]);
    expect(h.marker.at).toBe(START);
    await engine.stop();
  });
});

describe("the mark is not shared state between people", () => {
  it("is a plain time (the test double holds nothing else)", () => {
    const m = new MemorySignedOutMarker();
    m.write(5);
    expect(m.read()).toBe(5);
  });
});
