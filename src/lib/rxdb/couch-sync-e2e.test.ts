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
  MemoryJournal,
  PERSON,
  START,
} from "./test-support/couch-engine-harness";
import { toRfc3339 } from "./couch-docs";
import {
  LOCAL_WRITE_DEBOUNCE_MS,
  POLL_INTERVAL_MS,
  PUSH_DEBOUNCE_MS,
} from "./couch-schedule";
import type { Trigger } from "./couch-sync";
import { ensurePersonalDatabase, type CouchSession } from "./couch-session";

const TOKEN = "sign-in-token-for-tests-0123456789";

interface Device {
  browser: Browser;
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

/**
 * What a device keeps between page loads: the same database (one RxDB storage
 * and database name), the same app state, the same record of unwritten changes
 * and the same clock, so a "reload" is a new engine over all of them.
 */
interface Browser {
  name: string;
  storage: ReturnType<typeof getRxStorageMemory>;
  bridge: FakeBridge;
  journal: MemoryJournal;
  clock: Clock;
  deviceId: string;
  /** The person whose database this browser holds, once it has one. */
  recorded: string | null;
}

function browser(
  name: string,
  initial: ConstructorParameters<typeof FakeBridge>[0] = {},
): Browser {
  counter += 1;
  return {
    name,
    storage: getRxStorageMemory(),
    bridge: new FakeBridge(initial),
    journal: new MemoryJournal(),
    clock: new Clock(),
    deviceId: `${String(counter).padStart(8, "0")}-2222-4333-8444-555555555555`,
    recorded: null,
  };
}

function device(
  name: string,
  initial: ConstructorParameters<typeof FakeBridge>[0] = {},
  existing?: Browser,
): Device {
  const b = existing ?? browser(name, initial);
  const { clock, bridge, deviceId } = b;
  const flags = { online: true };
  const triggers = new Set<(k: Trigger) => void>();
  const engine = createCouchSyncEngine({
    recordedPerson: () => b.recorded,
    journal: b.journal,
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
        storage: b.storage as never,
        baseFetch: couch.fetch as typeof fetch,
        retryTimeMs: 10,
        cycleTimeoutMs: 5_000,
        nameSuffix: `_${b.name}_${deviceId.slice(0, 8)}`,
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
    browser: b,
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

  it("a device whose own non-default settings predate sync takes the person's, not the other way round", async () => {
    fresh();
    const a = device("a");
    await startDevice(a);
    a.clock.now = START + 600_000;
    a.bridge.change({
      theme: "dark",
      selectedActivities: ["livestock"],
    });
    await flush(a);

    // b has its own light theme and a gardening activity from before sync;
    // the server already has documents for the theme.
    const b = device("b", {
      theme: "light",
      selectedActivities: ["gardening"],
    });
    b.clock.now = START + 1_200_000;
    await startDevice(b);
    await flush(b);

    expect(couch.get("preference:theme")?.preferenceValue).toBe("dark");
    expect(b.bridge.state.theme).toBe("dark");
    // The activity b had is one the server has no document for: seeded, kept.
    expect(couch.liveIds().sort()).toEqual([
      "activity:gardening",
      "activity:livestock",
      "preference:theme",
    ]);
    expect([...b.bridge.state.selectedActivities].sort()).toEqual([
      "gardening",
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

  describe("a setting changed before the local database opened (offline, hidden, backing off)", () => {
    /** A device that starts offline and changes its theme at `madeAtMs`. */
    async function offlineDeviceThatChangedTheme(madeAtMs: number) {
      const b = device("b");
      b.flags.online = false;
      await startDevice(b);
      b.clock.now = madeAtMs;
      b.bridge.change({ theme: "light" });
      await b.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, b.settle);
      return b;
    }
    const comeOnline = async (b: Device, now: number) => {
      b.clock.now = now;
      b.flags.online = true;
      b.triggers.forEach((t) => t("online"));
      await b.settle();
      await flush(b);
    };

    it("wins over a remote value that is OLDER than the change, and is written", async () => {
      fresh();
      const a = device("a", { theme: "dark" }); // seeded at START
      await startDevice(a);
      expect(couch.get("preference:theme")?.preferenceValue).toBe("dark");

      const madeAt = START + 60_000;
      const b = await offlineDeviceThatChangedTheme(madeAt);
      await comeOnline(b, madeAt + 300_000);

      expect(couch.get("preference:theme")).toMatchObject({
        preferenceValue: "light",
        updatedAt: toRfc3339(madeAt),
      });
      expect(b.bridge.state.theme).toBe("light");
      // And the other device hears it.
      await a.sync();
      expect(a.bridge.state.theme).toBe("light");
    });

    it("loses to a remote value that is NEWER than the change, however late it connects", async () => {
      fresh();
      const a = device("a");
      await startDevice(a);
      a.clock.now = START + 600_000;
      a.bridge.change({ theme: "dark" });
      await flush(a);
      expect(couch.get("preference:theme")?.preferenceValue).toBe("dark");

      const b = await offlineDeviceThatChangedTheme(START + 60_000);
      await comeOnline(b, START + 900_000);

      expect(couch.get("preference:theme")?.preferenceValue).toBe("dark");
      expect(b.bridge.state.theme).toBe("dark");
    });

    // (The engine-level tests in couch-sync.test.ts cover the same change made
    // while the first credential fetch is failing and the engine backs off.)
  });

  describe("offline first: a change survives the page, however early it goes away", () => {
    /** A browser that has synced once, so it holds the person's database. */
    async function syncedBrowser(name: string): Promise<Browser> {
      const first = device(name);
      await startDevice(first);
      first.browser.recorded = PERSON;
      await first.engine.stop();
      return first.browser;
    }
    /** The same browser, a new page: a new engine over the same everything. */
    const reload = (b: Browser, online: boolean) => {
      const next = device(b.name, {}, b);
      next.flags.online = online;
      return next;
    };

    it("offline start, a change, a reload, then the connection comes back: it wins over an OLDER remote value and reaches the server", async () => {
      fresh();
      const a = device("a", { theme: "dark" }); // the remote value, at START
      await startDevice(a);
      expect(couch.get("preference:theme")?.preferenceValue).toBe("dark");

      const b = await syncedBrowser("b");
      expect(b.bridge.state.theme).toBe("dark"); // it received a's choice

      // Page two: starts offline and the person picks light.
      const madeAt = START + 120_000;
      b.clock.now = madeAt;
      const page2 = reload(b, false);
      await startDevice(page2);
      b.bridge.change({ theme: "light" });
      await b.clock.advance(LOCAL_WRITE_DEBOUNCE_MS, page2.settle);
      // Written to the person's database on the device, offline: nothing is
      // left only in the record.
      expect(b.journal.record).toBeNull();
      await page2.engine.stop(); // closed offline

      // Page three: still offline, then the connection returns.
      b.clock.now = madeAt + 600_000;
      const page3 = reload(b, false);
      await startDevice(page3);
      expect(b.bridge.state.theme).toBe("light");
      page3.flags.online = true;
      page3.triggers.forEach((t) => t("online"));
      await page3.settle();
      await flush(page3);

      expect(couch.get("preference:theme")).toMatchObject({
        preferenceValue: "light",
        updatedAt: toRfc3339(madeAt),
      });
      expect(b.bridge.state.theme).toBe("light");
      await a.sync();
      expect(a.bridge.state.theme).toBe("light");
    });

    it("a change inside the debounce window when the page goes away is written, and arrives", async () => {
      fresh();
      const a = device("a", { theme: "dark" });
      await startDevice(a);
      const b = await syncedBrowser("b");

      const madeAt = START + 120_000;
      b.clock.now = madeAt;
      const page2 = reload(b, false);
      await startDevice(page2);
      b.bridge.change({ theme: "light" });
      await page2.engine.stop(); // pagehide, 0 ms after the change

      b.clock.now = madeAt + 600_000;
      const page3 = reload(b, true);
      await startDevice(page3);
      await flush(page3);
      expect(couch.get("preference:theme")).toMatchObject({
        preferenceValue: "light",
        updatedAt: toRfc3339(madeAt),
      });
      expect(page3.bridge.state.theme).toBe("light");
    });

    it("a person's first session, offline, closed before any database exists: the next page still writes the change and it beats the older remote value", async () => {
      fresh();
      const a = device("a", { theme: "dark" });
      await startDevice(a);

      const b = browser("fresh-b", {});
      const page1 = device("fresh-b", {}, b);
      page1.flags.online = false;
      await startDevice(page1);
      const madeAt = START + 120_000;
      b.clock.now = madeAt;
      b.bridge.change({ theme: "light" });
      await page1.engine.stop(); // nothing was written anywhere
      expect(b.journal.record).not.toBeNull();

      b.clock.now = madeAt + 600_000;
      const page2 = device("fresh-b", {}, b);
      await startDevice(page2);
      await flush(page2);
      expect(couch.get("preference:theme")).toMatchObject({
        preferenceValue: "light",
        updatedAt: toRfc3339(madeAt),
      });
      expect(page2.bridge.state.theme).toBe("light");
    });
  });

  it("the person's own order of activities survives another device's add and remove", async () => {
    fresh();
    const a = device("a", { selectedActivities: ["livestock", "gardening"] });
    await startDevice(a);

    // This device chose them in the opposite order from the one the documents
    // sort in (same creation time, so by id: gardening, then livestock).
    const b = device("b", { selectedActivities: ["livestock", "gardening"] });
    await startDevice(b);
    expect(b.bridge.state.selectedActivities).toEqual([
      "livestock",
      "gardening",
    ]);

    a.clock.now = START + 120_000;
    a.bridge.change({
      selectedActivities: ["livestock", "gardening", "football"],
    });
    await flush(a);
    await b.sync();
    expect(b.bridge.state.selectedActivities).toEqual([
      "livestock",
      "gardening",
      "football",
    ]);

    a.clock.now = START + 240_000;
    a.bridge.change({ selectedActivities: ["livestock", "football"] });
    await flush(a);
    await b.sync();
    expect(b.bridge.state.selectedActivities).toEqual([
      "livestock",
      "football",
    ]);
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
