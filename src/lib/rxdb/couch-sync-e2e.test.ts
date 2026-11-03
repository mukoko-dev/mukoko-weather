/**
 * Two devices of one person, the real engine, real RxDB (memory storage) and
 * the fake CouchDB behind the gateway rules. The scenarios that matter to a
 * person: settings follow them to a new device, a fresh device never overwrites
 * what they chose elsewhere, an unselected activity goes away everywhere, and
 * an edit made offline arrives when the connection returns. The database does
 * not exist until the first device prepares it (`POST /v1/couch/personal`), as
 * on the real server. The credential itself is `couch-sync-grant-e2e.test.ts`.
 *
 * NOT VERIFIED here (needs the live service): the credential, CORS, the JWT
 * handler, the real CouchDB and PouchDB behaviours.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { createCouchSyncEngine, type CouchSyncEngine } from "./couch-sync";
import { openUserDocStore } from "./couch-rxdb";
import { FakeCouch } from "./test-support/couch-fake-server";
import {
  Clock,
  FakeBridge,
  GRANT_TTL_MS,
  PERSON,
} from "./test-support/couch-engine-harness";
import {
  LOCAL_WRITE_DEBOUNCE_MS,
  POLL_INTERVAL_MS,
  PUSH_DEBOUNCE_MS,
} from "./couch-schedule";
import type { Trigger } from "./couch-sync";
import { ensurePersonalDatabase, type CouchSession } from "./couch-session";

const TOKEN = "sign-in-token-for-tests-0123456789";

interface Device {
  bridge: FakeBridge;
  engine: CouchSyncEngine;
  clock: Clock;
  flags: { online: boolean };
  triggers: Set<(k: Trigger) => void>;
  settle: () => Promise<void>;
  sync: () => Promise<void>;
}

let couch: FakeCouch;
let counter = 0;
const devices: Device[] = [];

function device(
  name: string,
  initial: ConstructorParameters<typeof FakeBridge>[0] = {},
): Device {
  counter += 1;
  const clock = new Clock();
  const bridge = new FakeBridge(initial);
  const flags = { online: true };
  const triggers = new Set<(k: Trigger) => void>();
  const deviceId = `${String(counter).padStart(8, "0")}-2222-4333-8444-555555555555`;
  const engine = createCouchSyncEngine({
    fetchSession: async (): Promise<CouchSession> => ({
      token: TOKEN,
      expiresAtMs: clock.now + GRANT_TTL_MS,
      database: `user_${PERSON}`,
      personId: PERSON,
      databaseUrl: `https://api.test/v1/couch/db/user_${PERSON}/`,
    }),
    // The first device to sync makes the database; the others find it there.
    ensureDatabase: (s) =>
      ensurePersonalDatabase(s, couch.fetch as typeof fetch),
    openStore: (personId) =>
      openUserDocStore(personId, {
        storage: getRxStorageMemory() as never,
        baseFetch: couch.fetch as typeof fetch,
        retryTimeMs: 10,
        cycleTimeoutMs: 5_000,
        nameSuffix: `_${name}_${counter}`,
      }),
    bridge,
    deviceId,
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0.5,
    isOnline: () => flags.online,
    onTrigger: (l) => {
      triggers.add(l);
      return () => triggers.delete(l);
    },
  });
  const d: Device = {
    bridge,
    engine,
    clock,
    flags,
    triggers,
    settle: () => engine.idle(),
    sync: async () => {
      // A cycle at "now" regardless of the cooldowns: the poll timer.
      await clock.advance(POLL_INTERVAL_MS, () => engine.idle());
    },
  };
  devices.push(d);
  return d;
}

async function startDevice(d: Device): Promise<void> {
  await d.engine.start();
  await d.engine.idle();
}

/** Time to write a local change and push it. */
async function flush(d: Device): Promise<void> {
  await d.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, d.settle);
  await d.clock.advance(PUSH_DEBOUNCE_MS, d.settle);
}

afterEach(async () => {
  while (devices.length) await devices.pop()?.engine.stop();
});

function fresh(): void {
  couch = new FakeCouch({
    personId: PERSON,
    token: TOKEN,
    databaseExists: false,
  });
}

describe("settings follow the person", () => {
  it("a device that already had settings seeds them; a second device receives them", async () => {
    fresh();
    const a = device("a", {
      theme: "dark",
      selectedForecastModel: "ecmwf_ifs",
      selectedActivities: ["livestock", "crop-farming"],
    });
    await startDevice(a);
    expect(couch.liveIds().sort()).toEqual([
      "activity:crop-farming",
      "activity:livestock",
      "preference:forecastModel",
      "preference:theme",
    ]);

    const b = device("b"); // a new phone: default settings
    await startDevice(b);
    expect(b.bridge.state.theme).toBe("dark");
    expect(b.bridge.state.selectedForecastModel).toBe("ecmwf_ifs");
    expect([...b.bridge.state.selectedActivities].sort()).toEqual([
      "crop-farming",
      "livestock",
    ]);
  });

  it("a fresh device with default settings writes nothing to the server", async () => {
    fresh();
    const a = device("a", { theme: "dark" });
    await startDevice(a);
    const writesBefore = couch.calls.filter(
      (c) => c.path === "_bulk_docs",
    ).length;
    const b = device("b");
    await startDevice(b);
    await flush(b);
    expect(couch.calls.filter((c) => c.path === "_bulk_docs").length).toBe(
      writesBefore,
    );
    expect(couch.get("preference:theme")?.preferenceValue).toBe("dark");
    expect(b.bridge.state.theme).toBe("dark");
  });

  it("a change on one device reaches the other on its next cycle", async () => {
    fresh();
    const a = device("a");
    const b = device("b");
    await startDevice(a);
    await startDevice(b);

    a.bridge.change({ theme: "light", selectedActivities: ["gardening"] });
    await flush(a);
    expect(couch.get("preference:theme")?.preferenceValue).toBe("light");

    await b.sync();
    expect(b.bridge.state.theme).toBe("light");
    expect(b.bridge.state.selectedActivities).toEqual(["gardening"]);
  });

  it("unselecting an activity removes it on the other device", async () => {
    fresh();
    const a = device("a", { selectedActivities: ["livestock", "gardening"] });
    const b = device("b");
    await startDevice(a);
    await startDevice(b);
    expect([...b.bridge.state.selectedActivities].sort()).toEqual([
      "gardening",
      "livestock",
    ]);

    a.bridge.change({ selectedActivities: ["gardening"] });
    await flush(a);
    expect(couch.get("activity:livestock")).toMatchObject({ _deleted: true });

    await b.sync();
    expect(b.bridge.state.selectedActivities).toEqual(["gardening"]);
  });

  it("an edit made offline arrives when the connection returns", async () => {
    fresh();
    const a = device("a");
    await startDevice(a);
    a.flags.online = false;
    a.bridge.change({ selectedForecastModel: "gfs_seamless" });
    await flush(a);
    expect(couch.get("preference:forecastModel")).toBeUndefined();

    a.flags.online = true;
    a.triggers.forEach((t) => t("online"));
    await a.settle();
    expect(couch.get("preference:forecastModel")?.preferenceValue).toBe(
      "gfs_seamless",
    );
  });

  it("the later of two concurrent edits wins on both devices", async () => {
    fresh();
    const a = device("a", { theme: "light" });
    const b = device("b");
    await startDevice(a);
    await startDevice(b);

    // Both devices change the theme without hearing from each other. B's edit
    // is later in time.
    a.bridge.change({ theme: "dark" });
    await a.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, a.settle);
    b.clock.now = a.clock.now + 30_000;
    b.bridge.change({ theme: "system" });
    await b.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, b.settle);
    await b.clock.advance(PUSH_DEBOUNCE_MS, b.settle); // B pushes first
    await a.clock.advance(PUSH_DEBOUNCE_MS, a.settle); // A pushes into a conflict
    await b.sync();
    await a.sync();

    expect(couch.get("preference:theme")?.preferenceValue).toBe("system");
    expect(a.bridge.state.theme).toBe("system");
    expect(b.bridge.state.theme).toBe("system");
  });
});

describe("what never leaves the device", () => {
  it("documents of other types written by another client are neither stored nor sent back", async () => {
    fresh();
    // `interest` is a data-model type this client does not own (and one the
    // deployed validator accepts; see the contract-delta test in couch-docs.test.ts).
    const foreign = "interest:0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    expect(
      couch.seed({
        _id: foreign,
        type: "interest",
        schemaVersion: 1,
        ownerPersonId: PERSON,
        updatedAt: "2026-11-02T09:00:00.000Z",
        envelope: {
          protected: "p",
          aad: "a",
          iv: "i",
          ciphertext: "c",
          tag: "t",
        },
      }).ok,
    ).toBe(true);
    const a = device("a", { theme: "dark" });
    await startDevice(a);
    a.bridge.change({ selectedActivities: ["livestock"] });
    await flush(a);

    for (const call of couch.calls.filter((c) => c.path === "_bulk_docs")) {
      const ids = (call.body as { docs: { _id: string }[] }).docs.map(
        (d) => d._id,
      );
      expect(ids.every((id) => /^(activity|preference):/.test(id))).toBe(true);
    }
    // Still on the server, untouched, and never on this device.
    expect(couch.get(foreign)).toMatchObject({ type: "interest" });
    expect(
      a.bridge.applied.every((p) => !JSON.stringify(p).includes("interest")),
    ).toBe(true);
  });

  it("a locational setting in the app state is never turned into a document", async () => {
    fresh();
    const a = device("a", { theme: "dark" });
    // The app state may carry more fields; the engine only knows three.
    (a.bridge.state as unknown as Record<string, unknown>).homeLocation =
      "harare";
    (a.bridge.state as unknown as Record<string, unknown>).savedLocations = [
      "nairobi-ke",
    ];
    await startDevice(a);
    await flush(a);
    expect(couch.liveIds().sort()).toEqual(["preference:theme"]);
    expect(JSON.stringify(couch.calls.map((c) => c.body))).not.toMatch(
      /harare|nairobi/,
    );
  });
});

describe("every request is one the gateway allows", () => {
  it("across the whole scenario, nothing was refused", async () => {
    fresh();
    const a = device("a", { theme: "dark", selectedActivities: ["livestock"] });
    const b = device("b");
    await startDevice(a);
    await startDevice(b);
    a.bridge.change({ selectedActivities: [] });
    await flush(a);
    await b.sync();
    const refused = couch.calls.filter((c) => c.status >= 400);
    expect(refused).toEqual([]);
    const kinds = new Set(couch.calls.map((c) => `${c.method} ${c.path}`));
    for (const kind of kinds) {
      expect([
        "POST /v1/couch/personal",
        "GET _changes",
        "POST _all_docs",
        "POST _bulk_docs",
      ]).toContain(kind);
    }
    // The database is made before anything is read from it, once per device.
    expect(couch.calls[0]).toMatchObject({
      method: "POST",
      path: "/v1/couch/personal",
      status: 200,
    });
    expect(
      couch.calls.filter((c) => c.path === "/v1/couch/personal"),
    ).toHaveLength(2);
  });
});
