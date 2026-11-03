/**
 * The device's clock is not the server's clock. The credential comes with a
 * LIFETIME ("300 seconds from when I issued it"), never a time of day, and the
 * engine ends it by its OWN clock: sent-at plus lifetime. A device a few
 * minutes fast used to see every fresh five-minute credential as too short
 * (a silent retry loop to a 15-minute back-off), and a slow one kept using an
 * ended one. Manual clock: no real time passes.
 */
import { describe, expect, it } from "vitest";
import { createCouchSyncEngine } from "./couch-sync";
import { parseSessionBody, type CouchSession } from "./couch-session";
import { COUCH_MIN_GRANT_LIFE_MS } from "../couch-session-timing";
import { REFRESH_LEAD_MS } from "./couch-schedule";
import {
  GRANT_TTL_MS,
  PERSON,
  START,
  harness,
  type Harness,
} from "./test-support/couch-engine-harness";

const MINUTE = 60_000;

/**
 * What the route sends, parsed by the page's own parser. The route also (in
 * this test) sends an absolute time on the SERVER's clock, which is wrong by
 * the device's skew: the page must not read it.
 */
function routeAnswer(serverNowMs: number, lifeSeconds = 300): CouchSession {
  return parseSessionBody({
    token: "credential-for-tests-0123456789",
    expiresIn: lifeSeconds,
    expiresAt: new Date(serverNowMs + lifeSeconds * 1000).toISOString(),
    database: `user_${PERSON}`,
    apiOrigin: "https://api.test",
  });
}

async function startedAt(skewMs: number, over: Parameters<typeof harness>[0]) {
  const h: Harness = harness(over);
  // The device's clock is `skewMs` away from the server's (START is "true time").
  h.clock.now = START + skewMs;
  const engine = createCouchSyncEngine(h.deps);
  await engine.start();
  await engine.idle();
  return { h, engine };
}

describe.each([
  ["on time", 0],
  ["10 minutes fast", 10 * MINUTE],
  ["10 minutes slow", -10 * MINUTE],
])("a device clock that is %s", (_name, skew) => {
  const via = (): Parameters<typeof harness>[0] => ({
    // The server answers with ITS clock, which is `START` + elapsed device time.
    session: async () => routeAnswer(START),
  });

  it("accepts a fresh five-minute credential: one request, one replication, no back-off", async () => {
    const { h, engine } = await startedAt(skew, via());
    expect(engine.status()).toBe("idle");
    expect(h.sessions.fetched).toBe(1);
    expect(h.stores[0].replications).toBe(1);
    await engine.stop();
  });

  it("reuses it while it has more than a minute to live, by the device's own count", async () => {
    const { h, engine } = await startedAt(skew, via());
    await h.clock.advance(2 * MINUTE, () => engine.idle());
    expect(h.sessions.fetched).toBe(1);
    expect(h.stores[0].replications).toBeGreaterThan(1);
    await engine.stop();
  });

  it("renews it a minute before the five minutes are over, not at some time of day the server named", async () => {
    const { h, engine } = await startedAt(skew, via());
    // Just before the renewal point: still the first credential.
    await h.clock.advance(GRANT_TTL_MS - REFRESH_LEAD_MS - 1_000, () =>
      engine.idle(),
    );
    expect(h.sessions.fetched).toBe(1);
    // Just after it: a new one.
    await h.clock.advance(2_000, () => engine.idle());
    expect(h.sessions.fetched).toBe(2);
    await engine.stop();
  });

  it("a credential that has little life left on arrival is refused at the same threshold on every clock", async () => {
    const ok = await startedAt(skew, {
      session: async () => routeAnswer(START, COUCH_MIN_GRANT_LIFE_MS / 1000),
    });
    expect(ok.engine.status()).toBe("idle");
    await ok.engine.stop();

    const short = await startedAt(skew, {
      session: async () =>
        routeAnswer(START, COUCH_MIN_GRANT_LIFE_MS / 1000 - 1),
    });
    expect(short.engine.status()).toBe("backing_off");
    expect(short.h.stores).toHaveLength(0);
    await short.engine.stop();
  });
});

describe("the life is counted from when the request was SENT", () => {
  it("a slow answer has already used up its time: 100 s granted, 30 s on the way, 70 s left is under the floor", async () => {
    let h: Harness | null = null;
    const made = harness({
      session: async () => {
        // The request takes 30 s on the device's clock.
        (h as Harness).clock.now += 30_000;
        return routeAnswer(START, 100);
      },
    });
    h = made;
    const engine = createCouchSyncEngine(made.deps);
    await engine.start();
    await engine.idle();
    expect(COUCH_MIN_GRANT_LIFE_MS).toBeGreaterThan(70_000);
    expect(engine.status()).toBe("backing_off");
    expect(made.stores).toHaveLength(0);
    await engine.stop();
  });

  it("and the same credential answered at once is fine", async () => {
    const made = harness({ session: async () => routeAnswer(START, 100) });
    const engine = createCouchSyncEngine(made.deps);
    await engine.start();
    await engine.idle();
    expect(engine.status()).toBe("idle");
    await engine.stop();
  });
});
