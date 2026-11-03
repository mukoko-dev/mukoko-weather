/**
 * The whole credential chain, end to end, with nothing real in it:
 *
 *   a WorkOS access token (as AuthKit's session holds it)
 *     -> the real issuer and exchanger (`lib/couch-session-issuer.ts`)
 *     -> a fake Nyuchi API gateway applying the exchange rules
 *        (`lib/test-support/fake-nyuchi-gateway.ts`)
 *     -> the grant, shaped as the route answers it, read by the real client
 *        (`couch-session.ts`)
 *     -> the real engine and real RxDB (memory storage)
 *     -> `POST /v1/couch/personal`, then replication, against a fake CouchDB
 *        that accepts only a grant the fake gateway issued, in date, from a
 *        client still on its allow-list.
 *
 * One manual clock drives all of it. It shows the lifecycle a person
 * depends on: the first sync prepares the database, the grant is renewed
 * before it ends and never hot-loops, a client taken off the allow-list or a
 * gateway outage backs off and recovers without losing a change, and a person
 * whose deletion is scheduled syncs nothing.
 *
 * NOT VERIFIED here (needs the live service): the real gateway and its
 * signing, CORS from the browser, CouchDB's JWT handler, a real browser.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../observability", () => ({ logWarn: warn, logError: vi.fn() }));
import { createCouchSyncEngine, type CouchSyncEngine } from "./couch-sync";
import { openUserDocStore } from "./couch-rxdb";
import {
  CouchSessionError,
  ensurePersonalDatabase,
  parseSessionBody,
  type CouchSession,
} from "./couch-session";
import { FakeCouch } from "./test-support/couch-fake-server";
import { Clock, FakeBridge, PERSON } from "./test-support/couch-engine-harness";
import {
  LOCAL_WRITE_DEBOUNCE_MS,
  POLL_INTERVAL_MS,
  PUSH_DEBOUNCE_MS,
} from "./couch-schedule";
import {
  CouchIssueError,
  createCouchGrantExchanger,
  createCouchSessionIssuer,
} from "../couch-session-issuer";
import { COUCH_ACCESS_TOKEN_REFRESH_BUFFER_SECONDS } from "../couch-session-timing";
import {
  FakeNyuchiGateway,
  workosAccessToken,
} from "../test-support/fake-nyuchi-gateway";

const WORKOS_CLIENT = "client_mukoko_account";
const WORKOS_USER = "user_01HWORKOSUSER";
const KEY_ID = "nyk_weatherkey01";
const KEY_SECRET = "nys_supersecretvalue123";
const ACCESS_TOKEN_SECONDS = 300; // AuthKit's default lifetime

interface World {
  clock: Clock;
  gateway: FakeNyuchiGateway;
  couch: FakeCouch;
  bridge: FakeBridge;
  engine: CouchSyncEngine;
  /** How many times AuthKit refreshed the access token. */
  refreshes: () => number;
  /** Every WorkOS access token the session ever held. */
  accessTokens: string[];
  settle: () => Promise<void>;
  /** Advance time, letting the engine settle after every timer. */
  advance: (ms: number) => Promise<void>;
  /** Advance in `step` slices, calling `each` after every slice. */
  walk: (total: number, step: number, each: () => void) => Promise<void>;
  start: () => Promise<void>;
  /** A local change, written and pushed. */
  edit: (patch: Parameters<FakeBridge["change"]>[0]) => Promise<void>;
}

let counter = 0;
const worlds: World[] = [];

afterEach(async () => {
  while (worlds.length) await worlds.pop()?.engine.stop();
  warn.mockReset();
});

function world(
  options: {
    /** AuthKit's refresh buffer on the session route (the proxy sets 120). */
    refreshBufferSeconds?: number;
    deletionScheduled?: boolean;
    initial?: ConstructorParameters<typeof FakeBridge>[0];
  } = {},
): World {
  counter += 1;
  const clock = new Clock();
  const gateway = new FakeNyuchiGateway({
    consoleClientId: WORKOS_CLIENT,
    keys: {
      [KEY_ID]: { secret: KEY_SECRET, type: "internal", scopes: ["identity"] },
    },
    syncClientIds: [KEY_ID],
    persons: {
      [WORKOS_USER]: {
        id: PERSON,
        deletionScheduled: options.deletionScheduled,
      },
    },
    now: () => clock.now,
  });
  const couch = new FakeCouch({
    personId: PERSON,
    token: "unused: the grant decides",
    authorize: (authorization) => gateway.authorize(authorization),
    databaseExists: false,
  });

  // AuthKit's session: the access token is replaced when it has less than the
  // buffer left, which is what the proxy does on the session route.
  const buffer =
    options.refreshBufferSeconds ?? COUCH_ACCESS_TOKEN_REFRESH_BUFFER_SECONDS;
  const accessTokens: string[] = [];
  let bornAt = Number.NEGATIVE_INFINITY;
  let refreshCount = 0;
  const currentAccessToken = (): string => {
    const left = bornAt + ACCESS_TOKEN_SECONDS * 1000 - clock.now;
    if (accessTokens.length === 0 || left < buffer * 1000) {
      refreshCount += 1;
      bornAt = clock.now;
      accessTokens.push(
        workosAccessToken({
          sub: WORKOS_USER,
          clientId: WORKOS_CLIENT,
          nowMs: clock.now,
          lifeSeconds: ACCESS_TOKEN_SECONDS,
          sid: `session_${counter}_${refreshCount}`,
        }),
      );
    }
    return accessTokens[accessTokens.length - 1];
  };

  const issuer = createCouchSessionIssuer({
    exchanger: createCouchGrantExchanger({
      config: () => ({
        transport: gateway.transport,
        credentials: { clientId: KEY_ID, clientSecret: KEY_SECRET },
      }),
      consoleClientId: () => WORKOS_CLIENT,
      now: () => clock.now,
    }),
    now: () => clock.now,
  });

  /** What the page's `fetchCouchSession` gets from `POST /api/couch/session`. */
  const fetchSession = async (): Promise<CouchSession> => {
    try {
      const credential = await issuer.issue({
        userId: WORKOS_USER,
        accessToken: currentAccessToken(),
      });
      return parseSessionBody({
        token: credential.token,
        expiresIn: credential.expiresInSeconds,
        database: credential.database,
        apiOrigin: "https://api.test",
      });
    } catch (err) {
      // The route answers the issuer's refusals with their status and code.
      if (err instanceof CouchIssueError) {
        throw new CouchSessionError(err.status, err.code);
      }
      throw err;
    }
  };

  const bridge = new FakeBridge(options.initial);
  const engine = createCouchSyncEngine({
    fetchSession,
    ensureDatabase: (s) =>
      ensurePersonalDatabase(s, couch.fetch as typeof fetch),
    openStore: (personId) =>
      openUserDocStore(personId, {
        storage: getRxStorageMemory() as never,
        baseFetch: couch.fetch as typeof fetch,
        retryTimeMs: 10,
        cycleTimeoutMs: 5_000,
        nameSuffix: `_grant_${counter}`,
      }),
    bridge,
    deviceId: "11111111-2222-4333-8444-555555555555",
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0.5,
  });

  const settle = () => engine.idle();
  const advance = (ms: number) => clock.advance(ms, settle);
  const w: World = {
    clock,
    gateway,
    couch,
    bridge,
    engine,
    refreshes: () => refreshCount,
    accessTokens,
    settle,
    advance,
    walk: async (total, step, each) => {
      for (let done = 0; done < total; done += step) {
        await advance(step);
        each();
      }
    },
    start: async () => {
      await engine.start();
      await engine.idle();
    },
    edit: async (patch) => {
      bridge.change(patch);
      await advance(LOCAL_WRITE_DEBOUNCE_MS);
      await advance(PUSH_DEBOUNCE_MS);
    },
  };
  worlds.push(w);
  return w;
}

const callsOf = (w: World) => w.couch.calls.map((c) => `${c.method} ${c.path}`);

describe("the first sync", () => {
  it("trades the WorkOS token for the grant, prepares the database, then replicates under the grant", async () => {
    const w = world({ initial: { theme: "dark" } });
    await w.start();

    // One question to the gateway: couch:user alone, from the app's own key.
    expect(w.gateway.requests).toHaveLength(1);
    expect(w.gateway.requests[0]).toMatchObject({
      status: 200,
      form: { scope: "couch:user", client_id: KEY_ID },
    });

    // Prepared first (the proxy never creates a database), then replication.
    const calls = callsOf(w);
    expect(calls[0]).toBe("POST /v1/couch/personal");
    expect(calls.slice(1)).toEqual(
      expect.arrayContaining(["POST _changes", "POST _bulk_docs"]),
    );
    expect(calls.filter((c) => c === "POST /v1/couch/personal")).toHaveLength(
      1,
    );
    expect(w.couch.get("preference:theme")?.preferenceValue).toBe("dark");
    expect(w.engine.status()).toBe("idle");
    // Nothing was refused.
    expect(w.couch.calls.filter((c) => c.status >= 400)).toEqual([]);
  });

  it("the bearer on every request is the grant: never the WorkOS token", async () => {
    const w = world({ initial: { theme: "dark" } });
    await w.start();
    const bearers = new Set(w.couch.calls.map((c) => c.authorization));
    expect(bearers.size).toBe(1);
    const [only] = [...bearers];
    for (const at of w.accessTokens) {
      expect(only).not.toContain(at);
      expect(JSON.stringify(w.couch.calls)).not.toContain(at);
    }
    expect(JSON.stringify(w.couch.calls)).not.toContain(KEY_SECRET);
  });

  it("without the database prepared, replication would be a 404: the order matters", async () => {
    const w = world();
    // Skip the preparation: replicate under a real grant straight away.
    const session = await (async () => {
      const credential = await createCouchSessionIssuer({
        exchanger: createCouchGrantExchanger({
          config: () => ({
            transport: w.gateway.transport,
            credentials: { clientId: KEY_ID, clientSecret: KEY_SECRET },
          }),
          consoleClientId: () => WORKOS_CLIENT,
          now: () => w.clock.now,
        }),
        now: () => w.clock.now,
      }).issue({
        userId: WORKOS_USER,
        accessToken: workosAccessToken({
          sub: WORKOS_USER,
          clientId: WORKOS_CLIENT,
          nowMs: w.clock.now,
        }),
      });
      return credential;
    })();
    const res = await w.couch.fetch(
      `https://api.test/v1/couch/db/user_${PERSON}/_changes`,
      { headers: { authorization: `Bearer ${session.token}` } },
    );
    expect(res.status).toBe(404);
  });
});

describe("the grant is renewed before it ends", () => {
  it("about every four minutes, with no refused request and one preparation", async () => {
    const w = world({ initial: { theme: "dark" } });
    await w.start();
    await w.walk(20 * 60_000, POLL_INTERVAL_MS, () => {
      expect(w.engine.status()).toBe("idle");
    });
    expect(w.couch.calls.filter((c) => c.status >= 400)).toEqual([]);
    expect(
      w.couch.calls.filter((c) => c.path === "/v1/couch/personal"),
    ).toHaveLength(1);
    // 20 minutes at one grant per ~4: five renewals plus the first. A hot loop
    // or a per-poll exchange would be dozens.
    expect(w.gateway.requests.length).toBeGreaterThanOrEqual(5);
    expect(w.gateway.requests.length).toBeLessThanOrEqual(7);
    // Each exchange asked for the sync grant alone.
    expect(new Set(w.gateway.requests.map((r) => r.form.scope))).toEqual(
      new Set(["couch:user"]),
    );
  });

  it("an hour of an open tab stays far inside the route's 120 an hour", async () => {
    const w = world({ initial: { theme: "dark" } });
    await w.start();
    await w.advance(60 * 60_000);
    expect(w.gateway.requests.length).toBeLessThanOrEqual(16);
    expect(w.couch.calls.filter((c) => c.status >= 400)).toEqual([]);
  });

  it("a change made after several renewals still arrives", async () => {
    const w = world();
    await w.start();
    await w.advance(15 * 60_000);
    await w.edit({ selectedActivities: ["livestock"] });
    expect(w.couch.liveIds()).toEqual(["activity:livestock"]);
  });

  it("with AuthKit's own 30 s buffer a renewal would find a token with a minute left: the issuer refuses instead of looping, and the sync recovers", async () => {
    const w = world({ refreshBufferSeconds: 30 });
    await w.start();
    expect(w.gateway.requests).toHaveLength(1);

    // The renewal falls due at 4 minutes; the WorkOS token is then 1 minute
    // from its end. No grant is made from it, and the engine backs off.
    await w.advance(4 * 60_000 + 5_000);
    expect(w.gateway.requests).toHaveLength(1);
    expect(w.engine.status()).toBe("backing_off");
    expect(w.refreshes()).toBe(1);

    // Time passes, the token is replaced, the next try succeeds.
    await w.advance(2 * 60_000);
    expect(w.refreshes()).toBe(2);
    expect(w.gateway.requests.length).toBeLessThanOrEqual(2);
    await w.advance(POLL_INTERVAL_MS);
    expect(w.engine.status()).toBe("idle");
    await w.edit({ theme: "light" });
    expect(w.couch.get("preference:theme")?.preferenceValue).toBe("light");
    // Throughout, the server was never sent a request it had to refuse.
    expect(w.couch.calls.filter((c) => c.status >= 400)).toEqual([]);
  });

  it("with the proxy's 120 s buffer there is no such gap", async () => {
    const w = world({
      refreshBufferSeconds: COUCH_ACCESS_TOKEN_REFRESH_BUFFER_SECONDS,
    });
    await w.start();
    await w.walk(10 * 60_000, 10_000, () => {
      expect(w.engine.status()).toBe("idle");
    });
    expect(w.refreshes()).toBeGreaterThanOrEqual(2);
  });
});

describe("when the gateway says no, or is away", () => {
  it("a client taken off the allow-list stops the sync at once; putting it back resumes it with nothing lost", async () => {
    const w = world({ initial: { theme: "dark" } });
    await w.start();

    w.gateway.syncClientIds.delete(KEY_ID);
    w.bridge.change({ theme: "light" });
    await w.advance(LOCAL_WRITE_DEBOUNCE_MS);
    await w.advance(PUSH_DEBOUNCE_MS);
    // The outstanding grant is refused (403) and so is a new one (503).
    expect(w.engine.status()).toBe("backing_off");
    expect(w.couch.get("preference:theme")?.preferenceValue).toBe("dark");
    await w.advance(30_000);
    expect(w.engine.status()).toBe("backing_off");
    // The operator can see why, and nothing secret is in what they see.
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("invalid_scope");
    expect(logged).not.toContain(KEY_SECRET);
    for (const at of w.accessTokens) expect(logged).not.toContain(at);

    // Put back. The engine is on its back-off (doubling from 30 s, at most
    // 15 min) and the issuer remembers a refusal for 30 s, so it resumes
    // within a few minutes without anyone asking.
    w.gateway.syncClientIds.add(KEY_ID);
    await w.advance(4 * 60_000);
    expect(w.engine.status()).toBe("idle");
    expect(w.couch.get("preference:theme")?.preferenceValue).toBe("light");
    expect(w.bridge.state.theme).toBe("light");
  });

  it("a gateway outage at renewal backs off and recovers; changes made meanwhile are kept", async () => {
    const w = world();
    await w.start();
    await w.advance(3 * 60_000); // just before the renewal
    w.gateway.failNext = { status: 503, count: 2 };
    w.bridge.change({ selectedForecastModel: "gfs_seamless" });
    await w.advance(2 * 60_000);
    expect(w.engine.status()).toBe("backing_off");
    await w.advance(5 * 60_000);
    expect(w.engine.status()).toBe("idle");
    expect(w.couch.get("preference:forecastModel")?.preferenceValue).toBe(
      "gfs_seamless",
    );
    expect(w.couch.calls.filter((c) => c.status >= 400)).toEqual([]);
  });

  it("past the gateway's per-person limit the engine waits, it does not hammer", async () => {
    const w = world();
    w.gateway.failNext = { status: 429, count: 3, retryAfter: "60" };
    await w.engine.start();
    await w.engine.idle();
    expect(w.engine.status()).toBe("backing_off");
    await w.advance(10 * 60_000);
    expect(w.gateway.requests.length).toBeLessThanOrEqual(6);
    expect(w.engine.status()).toBe("idle");
  });

  it("a person whose deletion is scheduled syncs nothing: no database prepared, nothing replicated", async () => {
    const w = world({ deletionScheduled: true, initial: { theme: "dark" } });
    await w.start();
    expect(w.engine.status()).toBe("backing_off");
    expect(w.couch.calls).toEqual([]);
    expect(w.gateway.requests[0]).toMatchObject({
      status: 400,
      error: "invalid_grant",
    });
    // And it does not retry in a loop while the deletion is pending.
    await w.advance(10 * 60_000);
    expect(w.gateway.requests.length).toBeLessThanOrEqual(5);
    expect(w.couch.calls).toEqual([]);
    expect(w.bridge.state.theme).toBe("dark");
  });
});
