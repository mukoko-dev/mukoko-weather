/**
 * The RxDB layer against a fake CouchDB that applies the gateway's request
 * allow-list and runs the pinned validate_doc_update function: real RxDB (memory
 * storage), the real CouchDB replication plugin, no network.
 *
 * What this proves: the requests the plugin makes are all ones the gateway
 * lets through; what it writes passes the validator CouchDB runs (the pinned
 * copy of nyuchi-api's generated function, `__fixtures__/`); a delete carries
 * the common fields the validator requires; documents the client does not own
 * never reach the device; and the conflict rule decides concurrent edits,
 * deletes included. What it cannot prove: behaviour of the live CouchDB, the JWT
 * handler, CORS or the credential (see the PR).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import {
  openUserDocStore,
  purgeUserDocStores,
  removeUserDocStore,
} from "./couch-rxdb";
import {
  SYNC_PEOPLE_KEY,
  forgetSyncPerson,
  recordedSyncPeople,
} from "./sync-people-index";
import { FakeCouch } from "./test-support/couch-fake-server";
import { envelopeFor } from "./test-support/couch-validator-facts";
import {
  COUCH_DOC_SCHEMA_VERSION,
  activityDocId,
  preferenceDocId,
  toRfc3339,
  type UserDocType,
} from "./couch-docs";
import { CouchHttpError } from "./couch-fetch";
import type { CouchSession } from "./couch-session";
import type { SyncStore } from "./couch-sync";

const PERSON = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const DEVICE = "11111111-2222-4333-8444-555555555555";
const TOKEN = "sign-in-token-for-tests-0123456789";
const T0 = Date.parse("2026-11-02T10:00:00.000Z");

let suffix = 0;
let couch: FakeCouch;
const stores: SyncStore[] = [];

function session(): CouchSession {
  return {
    token: TOKEN,
    expiresInMs: 600_000,
    database: `user_${PERSON}`,
    personId: PERSON,
    databaseUrl: `https://api.test/v1/couch/db/user_${PERSON}/`,
  };
}

async function open(): Promise<SyncStore> {
  suffix += 1;
  const store = await openUserDocStore(PERSON, {
    storage: getRxStorageMemory() as never,
    baseFetch: couch.fetch as typeof fetch,
    retryTimeMs: 10,
    cycleTimeoutMs: 5_000,
    nameSuffix: `_t${suffix}`,
  });
  if (!store) throw new Error("store did not open");
  stores.push(store);
  return store;
}

function activity(id: string, atMs = T0): UserDocType {
  const t = toRfc3339(atMs);
  return {
    id: activityDocId(id),
    type: "activity",
    schemaVersion: COUCH_DOC_SCHEMA_VERSION,
    deviceId: DEVICE,
    createdAt: t,
    updatedAt: t,
    activityId: id,
  };
}

function theme(value: string, atMs = T0): UserDocType {
  const t = toRfc3339(atMs);
  return {
    id: preferenceDocId("theme"),
    type: "preference",
    schemaVersion: COUCH_DOC_SCHEMA_VERSION,
    deviceId: DEVICE,
    createdAt: t,
    updatedAt: t,
    preferenceKey: "theme",
    preferenceValue: value,
  };
}

function forecastModel(value: string, atMs = T0): UserDocType {
  const t = toRfc3339(atMs);
  return {
    id: preferenceDocId("forecastModel"),
    type: "preference",
    schemaVersion: COUCH_DOC_SCHEMA_VERSION,
    deviceId: DEVICE,
    createdAt: t,
    updatedAt: t,
    preferenceKey: "forecastModel",
    preferenceValue: value,
  };
}

/**
 * A deletion as another device writes it: the common fields (the validator
 * makes every document carry them) and nothing else.
 */
function remoteTombstone(
  id: string,
  type: "activity" | "preference",
  rev: string,
  atMs: number,
): Record<string, unknown> {
  return {
    _id: id,
    _rev: rev,
    _deleted: true,
    type,
    schemaVersion: COUCH_DOC_SCHEMA_VERSION,
    deviceId: DEVICE,
    createdAt: toRfc3339(T0),
    updatedAt: toRfc3339(atMs),
  };
}

/** What another device would have written to CouchDB. */
function wire(doc: UserDocType): Record<string, unknown> {
  const { id, ...rest } = doc;
  return { _id: id, ...rest };
}

beforeEach(() => {
  couch = new FakeCouch({ personId: PERSON, token: TOKEN });
});

afterEach(async () => {
  while (stores.length) await stores.pop()?.close();
});

describe("whose database it is: recorded when opened, removed on sign-out or a different person", () => {
  const OTHER = "0190ffff-0000-7000-8000-00000000abcd";
  let data: Map<string, string>;
  beforeEach(() => {
    data = new Map();
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const opts = (suffix: string) => ({
    storage: getRxStorageMemory() as never,
    baseFetch: couch.fetch as typeof fetch,
    retryTimeMs: 10,
    cycleTimeoutMs: 5_000,
    nameSuffix: suffix,
  });
  const openFor = async (person: string, suffix: string) => {
    const store = await openUserDocStore(person, opts(suffix));
    if (!store) throw new Error("store did not open");
    return store;
  };

  it("opening a person's database records their id, and nothing else is stored", async () => {
    const store = await openFor(PERSON, "_rec");
    stores.push(store);
    expect(recordedSyncPeople()).toEqual([PERSON]);
    expect([...data.keys()]).toEqual([SYNC_PEOPLE_KEY]);
  });

  it("removing deletes the data (a reopened database is empty) and the record", async () => {
    const first = await openFor(PERSON, "_rm");
    await first.upsert(theme("dark"));
    await first.upsert(activity("livestock"));
    expect((await first.liveDocs()).length).toBe(2);
    await first.close();

    expect(await removeUserDocStore(PERSON, opts("_rm"))).toBe(true);
    forgetSyncPerson(PERSON);

    const again = await openFor(PERSON, "_rm");
    stores.push(again);
    expect(await again.liveDocs()).toEqual([]);
  });

  it("purging removes every recorded person except the one kept, and forgets each", async () => {
    const a = await openFor(PERSON, "_pg");
    await a.upsert(theme("dark"));
    await a.close();
    const b = await openFor(OTHER, "_pg");
    await b.upsert(theme("light"));
    await b.close();
    expect(recordedSyncPeople().sort()).toEqual([OTHER, PERSON].sort());

    await purgeUserDocStores(OTHER, opts("_pg"));
    expect(recordedSyncPeople()).toEqual([OTHER]);

    const aAgain = await openFor(PERSON, "_pg");
    stores.push(aAgain);
    expect(await aAgain.liveDocs()).toEqual([]); // removed
    const bAgain = await openFor(OTHER, "_pg");
    stores.push(bAgain);
    expect((await bAgain.liveDocs()).map((d) => d.preferenceValue)).toEqual([
      "light",
    ]); // kept
  });

  it("purging for nobody (signed out) removes everyone", async () => {
    const a = await openFor(PERSON, "_all");
    await a.upsert(theme("dark"));
    await a.close();
    await purgeUserDocStores(null, opts("_all"));
    expect(recordedSyncPeople()).toEqual([]);
    const again = await openFor(PERSON, "_all");
    stores.push(again);
    expect(await again.liveDocs()).toEqual([]);
  });

  it("a database that cannot be removed stays recorded for the next try, and nothing throws", async () => {
    const a = await openFor(PERSON, "_blk");
    await a.close();
    const blocked = {
      ...opts("_blk"),
      storage: {
        ...(getRxStorageMemory() as object),
        createStorageInstance: async () => {
          throw new Error("IndexedDB is blocked");
        },
      } as never,
    };
    await expect(purgeUserDocStores(null, blocked)).resolves.toBeUndefined();
    expect(recordedSyncPeople()).toEqual([PERSON]);
    expect(await removeUserDocStore(PERSON, blocked)).toBe(false);
  });

  it("with nothing recorded, or no browser storage at all, a purge is a quiet no-op", async () => {
    await expect(purgeUserDocStores(null, opts("_none"))).resolves.toBe(
      undefined,
    );
    vi.stubGlobal("window", undefined);
    await expect(purgeUserDocStores(PERSON, opts("_none"))).resolves.toBe(
      undefined,
    );
  });

  it("opening never throws when the record cannot be written (storage blocked)", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    });
    const store = await openFor(PERSON, "_blkstore");
    stores.push(store);
    await store.upsert(theme("dark"));
    expect((await store.liveDocs()).length).toBe(1);
  });
});

describe("one tab replicates", () => {
  it("a lone tab becomes the leader", async () => {
    const store = await open();
    expect(await store.isLeader?.()).toBe(true);
  });

  it("the shared-database listener hears writes and stops when unsubscribed", async () => {
    const store = await open();
    const heard = vi.fn();
    const off = store.onShared?.(heard);
    expect(off).toBeTypeOf("function");
    await store.upsert(theme("dark"));
    await vi.waitFor(() => expect(heard).toHaveBeenCalled());
    off?.();
    heard.mockClear();
    await store.upsert(theme("light", T0 + 1_000));
    await new Promise((r) => setTimeout(r, 50));
    expect(heard).not.toHaveBeenCalled();
  });
});

describe("knownIds (the seeding guard: defaults never win)", () => {
  it("names the ids that have a document, live or deleted, and only those", async () => {
    const store = await open();
    expect([
      ...(await store.knownIds(["preference:theme", "activity:a"])),
    ]).toEqual([]);

    await store.upsert(theme("dark"));
    await store.upsert(activity("a"));
    await store.upsert(activity("b"));
    await store.tombstone("activity:b", T0 + 1_000, DEVICE);
    const known = await store.knownIds([
      "preference:theme",
      "activity:a",
      "activity:b",
      "activity:never",
    ]);
    // The ids themselves, not positions in a list: RxDB 17 answers a lookup
    // by id with an array of documents.
    expect([...known].sort()).toEqual([
      "activity:a",
      "activity:b",
      "preference:theme",
    ]);
    expect(known.has("activity:never")).toBe(false);
  });
});

describe("push", () => {
  it("writes a local document to CouchDB in a shape the validator accepts", async () => {
    const store = await open();
    await store.upsert(activity("crop-farming"));
    await store.runReplication(session());

    const stored = couch.get("activity:crop-farming");
    expect(stored).toMatchObject({
      type: "activity",
      activityId: "crop-farming",
      schemaVersion: "v3.1",
      deviceId: DEVICE,
    });
    // The database is the ownership: the old contract's field is not written.
    expect(stored).not.toHaveProperty("ownerPersonId");
    expect(couch.calls.every((c) => c.status < 400)).toBe(true);
  });

  it("every setting it syncs and every activity is accepted by the validator, in one push", async () => {
    const store = await open();
    await store.upsert(theme("dark"));
    await store.upsert(forecastModel("gfs_seamless"));
    await store.upsert(activity("crop-farming"));
    await store.upsert(activity("livestock"));
    await store.runReplication(session());
    expect(couch.liveIds().sort()).toEqual([
      "activity:crop-farming",
      "activity:livestock",
      "preference:forecastModel",
      "preference:theme",
    ]);
    expect(couch.calls.every((c) => c.status < 400)).toBe(true);
  });

  it("refuses, before it is stored, a document the validator would refuse", async () => {
    const store = await open();
    await expect(
      store.upsert({ ...activity("livestock"), schemaVersion: "v2.0" }),
    ).rejects.toThrow(/couch-sync/);
    await expect(
      store.upsert({ ...activity("livestock"), deviceId: "device-1" }),
    ).rejects.toThrow(/couch-sync/);
    // The Météo-France pick is not in the validator's enum: it stays local.
    await expect(
      store.upsert(forecastModel("meteofrance_seamless")),
    ).rejects.toThrow(/couch-sync/);
    expect(await store.liveDocs()).toEqual([]);
  });

  it("sends the person's credential on every request and nothing else", async () => {
    const store = await open();
    await store.upsert(theme("dark"));
    await store.runReplication(session());
    expect(couch.calls.length).toBeGreaterThan(0);
    for (const call of couch.calls) {
      expect(call.authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("only makes requests the gateway allows (changes, all_docs, bulk_docs)", async () => {
    const store = await open();
    await store.upsert(activity("livestock"));
    await store.runReplication(session());
    const seen = new Set(couch.calls.map((c) => `${c.method} ${c.path}`));
    expect([...seen].sort()).toEqual(
      ["POST _changes", "POST _all_docs", "POST _bulk_docs"].sort(),
    );
    expect(couch.calls.every((c) => c.status < 400)).toBe(true);
  });

  describe("cancelReplication (the page is going away)", () => {
    /** A transport whose requests never answer, until they are aborted. */
    function hungTransport() {
      const seen = { requests: 0, aborted: 0 };
      const baseFetch = ((_url: string, init?: RequestInit) => {
        seen.requests += 1;
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            seen.aborted += 1;
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }) as unknown as typeof fetch;
      return { seen, baseFetch };
    }

    async function openOver(baseFetch: typeof fetch): Promise<SyncStore> {
      suffix += 1;
      const store = await openUserDocStore(PERSON, {
        storage: getRxStorageMemory() as never,
        baseFetch,
        retryTimeMs: 10,
        cycleTimeoutMs: 60_000, // far longer than the test
        nameSuffix: `_c${suffix}`,
      });
      if (!store) throw new Error("store did not open");
      stores.push(store);
      return store;
    }

    it("ends the running replication at once, aborts its requests, and the replication fails as 'no answer'", async () => {
      const { seen, baseFetch } = hungTransport();
      const store = await openOver(baseFetch);
      const running = store.runReplication(session());
      const outcome = running.then(
        () => "finished",
        (e: unknown) => e,
      );
      for (let i = 0; i < 200 && seen.requests === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(seen.requests).toBeGreaterThan(0);

      store.cancelReplication?.();
      const result = await Promise.race([
        outcome,
        new Promise((r) => setTimeout(() => r("still running"), 3_000)),
      ]);
      expect(result).toBeInstanceOf(CouchHttpError);
      expect(result).toMatchObject({ status: 0 });
      expect(seen.aborted).toBeGreaterThan(0);
    });

    it("with nothing running it does nothing", async () => {
      const store = await open();
      expect(() => store.cancelReplication?.()).not.toThrow();
      await store.runReplication(session()); // and the next one works
      expect(couch.calls.length).toBeGreaterThan(0);
    });
  });

  it("never asks for a live or continuous feed", async () => {
    const store = await open();
    await store.runReplication(session());
    const changes = couch.calls.filter((c) => c.path === "_changes");
    expect(changes.length).toBeGreaterThan(0);
    for (const c of changes) {
      expect(c.query).toContain("feed=normal");
      expect(c.query).not.toMatch(/feed=(longpoll|continuous|eventsource)/);
    }
  });

  it("deletes with a tombstone that carries the common fields (and not the activity): a bare stub would be refused", async () => {
    const store = await open();
    await store.upsert(activity("gardening"));
    await store.runReplication(session());
    expect(couch.liveIds()).toContain("activity:gardening");

    await store.tombstone("activity:gardening", T0 + 1000, DEVICE);
    await store.runReplication(session());

    const stored = couch.get("activity:gardening");
    expect(stored).toMatchObject({
      _id: "activity:gardening",
      _deleted: true,
      type: "activity",
      schemaVersion: "v3.1",
      deviceId: DEVICE,
      createdAt: toRfc3339(T0),
      // The time of the deletion, which orders it against an edit elsewhere.
      updatedAt: toRfc3339(T0 + 1000),
    });
    const common = [
      "_deleted",
      "_id",
      "_rev",
      "createdAt",
      "deviceId",
      "schemaVersion",
      "type",
      "updatedAt",
    ];
    expect(Object.keys(stored ?? {}).sort()).toEqual(common);
    const bulk = couch.calls.filter((c) => c.path === "_bulk_docs").at(-1);
    const sent = (bulk?.body as { docs: Record<string, unknown>[] }).docs[0];
    expect(Object.keys(sent).sort()).toEqual(common);
    expect(couch.calls.every((c) => c.status < 400)).toBe(true);
  });

  it("the tombstone is written by the install that deleted it, even when another install wrote the document", async () => {
    const OTHER_DEVICE = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
    const store = await open();
    await store.upsert({ ...activity("gardening"), deviceId: OTHER_DEVICE });
    await store.runReplication(session());
    await store.tombstone("activity:gardening", T0 + 1000, DEVICE);
    await store.runReplication(session());
    expect(couch.get("activity:gardening")).toMatchObject({
      _deleted: true,
      deviceId: DEVICE,
    });
  });

  it("a deleted setting is a tombstone too, without its key or value", async () => {
    const store = await open();
    await store.upsert(theme("dark"));
    await store.runReplication(session());
    await store.tombstone("preference:theme", T0 + 1000, DEVICE);
    await store.runReplication(session());
    const stored = couch.get("preference:theme");
    expect(stored).toMatchObject({ _deleted: true, type: "preference" });
    expect(stored).not.toHaveProperty("preferenceKey");
    expect(stored).not.toHaveProperty("preferenceValue");
  });

  it("a second cycle with no changes pushes nothing", async () => {
    const store = await open();
    await store.upsert(activity("livestock"));
    await store.runReplication(session());
    const before = couch.calls.filter((c) => c.path === "_bulk_docs").length;
    await store.runReplication(session());
    expect(couch.calls.filter((c) => c.path === "_bulk_docs").length).toBe(
      before,
    );
  });

  it("re-selecting an activity after it was deleted writes it again", async () => {
    const store = await open();
    await store.upsert(activity("gardening"));
    await store.runReplication(session());
    await store.tombstone("activity:gardening", T0 + 1000, DEVICE);
    await store.runReplication(session());
    await store.upsert(activity("gardening", T0 + 2000));
    await store.runReplication(session());
    expect(couch.liveIds()).toContain("activity:gardening");
  });
});

describe("pull", () => {
  it("brings documents written elsewhere onto the device", async () => {
    couch.seed(wire(activity("horticulture")));
    couch.seed(wire(theme("dark")));
    const store = await open();
    await store.runReplication(session());
    const docs = await store.liveDocs();
    expect(docs.map((d) => d.id).sort()).toEqual([
      "activity:horticulture",
      "preference:theme",
    ]);
    expect(docs.find((d) => d.id === "preference:theme")?.preferenceValue).toBe(
      "dark",
    );
  });

  it("drops documents of types this client does not own", async () => {
    // Other clients' documents, each one the validator accepts: encrypted
    // places and the home place carry an envelope, a language is plaintext.
    const common = {
      schemaVersion: "v3.1",
      deviceId: DEVICE,
      createdAt: toRfc3339(T0),
      updatedAt: toRfc3339(T0),
    };
    const saved = "savedPlace:0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    const interest = "interest:0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
    for (const [id, type] of [
      [saved, "savedPlace"],
      [interest, "interest"],
      ["preference:homePlace", "preference"],
    ] as const) {
      expect(
        couch.seed({ _id: id, type, ...common, envelope: envelopeFor(id) }),
        id,
      ).toEqual({ ok: true });
    }
    expect(
      couch.seed({
        _id: "preference:language",
        type: "preference",
        ...common,
        preferenceKey: "language",
        preferenceValue: "sn",
      }),
    ).toEqual({ ok: true });
    couch.seed(wire(activity("livestock")));

    const store = await open();
    await store.runReplication(session());

    expect((await store.liveDocs()).map((d) => d.id)).toEqual([
      "activity:livestock",
    ]);
    // ...and nothing of theirs is ever written back.
    const bulk = couch.calls.filter((c) => c.path === "_bulk_docs");
    expect(bulk).toHaveLength(0);
  });

  it("applies a delete made on another device", async () => {
    couch.seed(wire(activity("gardening")));
    const store = await open();
    await store.runReplication(session());
    expect((await store.liveDocs()).map((d) => d.id)).toContain(
      "activity:gardening",
    );

    const rev = couch.get("activity:gardening")?._rev as string;
    expect(
      couch.seed(
        remoteTombstone("activity:gardening", "activity", rev, T0 + 1),
      ),
    ).toEqual({ ok: true });
    await store.runReplication(session());
    expect((await store.liveDocs()).map((d) => d.id)).not.toContain(
      "activity:gardening",
    );
  });

  it("a forecast model another client set, which this app does not offer, is stored but never applied to the app, and does not stop this device's own edit of that setting", async () => {
    couch.seed(wire(forecastModel("jma_gsm", T0)));
    const store = await open();
    await store.runReplication(session());
    // It is on the device as a document (the app ignores its value)...
    expect(
      (await store.liveDocs()).find((d) => d.id === "preference:forecastModel")
        ?.preferenceValue,
    ).toBe("jma_gsm");
    // ...and this device's own pick pushes over it: the assumed master state,
    // which holds the value this app cannot show, is let through by shape.
    await store.upsert(forecastModel("ecmwf_ifs", T0 + 5_000));
    await store.runReplication(session());
    expect(couch.get("preference:forecastModel")?.preferenceValue).toBe(
      "ecmwf_ifs",
    );
    expect(couch.calls.every((c) => c.status < 400)).toBe(true);
  });
});

describe("conflicts (last writer wins by updatedAt, master on a tie)", () => {
  it("keeps the later edit when this device is newer", async () => {
    couch.seed(wire(theme("light", T0)));
    const store = await open();
    await store.runReplication(session());
    // Both sides change; the device's edit is later.
    await store.upsert(theme("dark", T0 + 5_000));
    const rev = couch.get("preference:theme")?._rev as string;
    couch.seed({ ...wire(theme("system", T0 + 1_000)), _rev: rev });
    await store.runReplication(session());
    expect(couch.get("preference:theme")?.preferenceValue).toBe("dark");
    expect(
      (await store.liveDocs()).find((d) => d.id === "preference:theme")
        ?.preferenceValue,
    ).toBe("dark");
  });

  it("keeps the server's edit when it is newer", async () => {
    couch.seed(wire(theme("light", T0)));
    const store = await open();
    await store.runReplication(session());
    await store.upsert(theme("dark", T0 + 1_000));
    const rev = couch.get("preference:theme")?._rev as string;
    couch.seed({ ...wire(theme("system", T0 + 9_000)), _rev: rev });
    await store.runReplication(session());
    expect(couch.get("preference:theme")?.preferenceValue).toBe("system");
    expect(
      (await store.liveDocs()).find((d) => d.id === "preference:theme")
        ?.preferenceValue,
    ).toBe("system");
  });

  it("on an equal updatedAt the server's revision stays", async () => {
    couch.seed(wire(theme("light", T0)));
    const store = await open();
    await store.runReplication(session());
    await store.upsert({ ...theme("dark", T0 + 4_000) });
    const rev = couch.get("preference:theme")?._rev as string;
    couch.seed({ ...wire(theme("system", T0 + 4_000)), _rev: rev });
    await store.runReplication(session());
    expect(couch.get("preference:theme")?.preferenceValue).toBe("system");
  });

  // A tombstone carries updatedAt (the validator makes it), so a delete and an
  // edit are ordered by their times and nothing wins merely for being a delete.
  describe("a delete is ordered like any other revision", () => {
    it("an activity picked again here AFTER another device removed it comes back", async () => {
      couch.seed(wire(activity("gardening", T0)));
      const store = await open();
      await store.runReplication(session());
      // Another device removes it at T0 + 1 s...
      const rev = couch.get("activity:gardening")?._rev as string;
      couch.seed(
        remoteTombstone("activity:gardening", "activity", rev, T0 + 1_000),
      );
      // ...and this device edits its copy at T0 + 9 s (picked again).
      await store.upsert(activity("gardening", T0 + 9_000));
      await store.runReplication(session());
      expect(couch.liveIds()).toContain("activity:gardening");
      expect((await store.liveDocs()).map((d) => d.id)).toContain(
        "activity:gardening",
      );
    });

    it("a removal by another device that came AFTER this device's edit wins", async () => {
      couch.seed(wire(activity("gardening", T0)));
      const store = await open();
      await store.runReplication(session());
      await store.upsert(activity("gardening", T0 + 1_000));
      const rev = couch.get("activity:gardening")?._rev as string;
      couch.seed(
        remoteTombstone("activity:gardening", "activity", rev, T0 + 9_000),
      );
      await store.runReplication(session());
      expect(couch.liveIds()).not.toContain("activity:gardening");
      expect((await store.liveDocs()).map((d) => d.id)).not.toContain(
        "activity:gardening",
      );
    });

    it("a removal here newer than another device's edit wins on the server", async () => {
      couch.seed(wire(activity("gardening", T0)));
      const store = await open();
      await store.runReplication(session());
      await store.tombstone("activity:gardening", T0 + 9_000, DEVICE);
      const rev = couch.get("activity:gardening")?._rev as string;
      couch.seed({ ...wire(activity("gardening", T0 + 1_000)), _rev: rev });
      await store.runReplication(session());
      expect(couch.liveIds()).not.toContain("activity:gardening");
    });
  });
});

describe("failures", () => {
  it("a refused credential is a CouchHttpError(401) and the cycle ends", async () => {
    const store = await open();
    couch.token = "rotated";
    await expect(store.runReplication(session())).rejects.toMatchObject({
      name: "CouchHttpError",
      status: 401,
    });
  });

  it("a server error is surfaced with its status, not retried for ever", async () => {
    const store = await open();
    couch.failNext = { status: 503, count: 100 };
    const started = Date.now();
    await expect(store.runReplication(session())).rejects.toBeInstanceOf(
      CouchHttpError,
    );
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("no answer at all (offline) is status 0", async () => {
    const store = await open();
    couch.failNext = { status: 0, count: 100 };
    await expect(store.runReplication(session())).rejects.toMatchObject({
      status: 0,
    });
  });

  it("a write the validator refuses fails the cycle instead of looping", async () => {
    // A device whose clock is more than a day ahead of the server's: its
    // updatedAt is refused ("updatedAt is too far ahead"), as are all its writes.
    couch = new FakeCouch({
      personId: PERSON,
      token: TOKEN,
      serverNowMs: () => T0 - 3 * 86_400_000,
    });
    const store = await open();
    await store.upsert(activity("livestock"));
    await expect(store.runReplication(session())).rejects.toBeInstanceOf(
      CouchHttpError,
    );
    expect(couch.get("activity:livestock")).toBeUndefined();
  });
});

describe(
  "a cycle that cannot be wound down never holds the page",
  {
    timeout: 30_000,
  },
  () => {
    // Ending a failed or abandoned cycle relies on one RxDB internal
    // (`endReplicationRetries`, pinned in `couch-rxdb-internals.test.ts`). If a
    // future RxDB changes it, `cancel()` of the plugin queues behind a start that
    // never finishes, and the `finally` of the cycle would wait for ever (and the
    // engine's chain, `stop()` and the pagehide with it). So the wait is bounded.
    const brokenEnd = () => undefined; // an upgrade that made the internal inert

    async function openBroken(over: { cancelTimeoutMs?: number } = {}) {
      suffix += 1;
      const store = await openUserDocStore(PERSON, {
        storage: getRxStorageMemory() as never,
        baseFetch: couch.fetch as typeof fetch,
        retryTimeMs: 10,
        // Longer than the leader election a first replication waits for (about
        // 400 ms): the failure must be the request's, not the cycle's timer.
        cycleTimeoutMs: 5_000,
        cancelTimeoutMs: 300,
        closeTimeoutMs: 300,
        endCycle: brokenEnd,
        nameSuffix: `_w${suffix}`,
        ...over,
      });
      if (!store) throw new Error("store did not open");
      stores.push(store);
      return store;
    }

    it("a failing request with the internal inert: the cycle still ends, within the cycle timeout plus the cancel timeout, as an error the engine backs off on", async () => {
      const store = await openBroken();
      couch.failNext = { status: 503, count: 1_000 };
      const started = Date.now();
      const outcome = await Promise.race([
        store.runReplication(session()).then(
          () => "finished",
          (e: unknown) => e,
        ),
        new Promise((r) => setTimeout(() => r("hung"), 15_000)),
      ]);
      expect(outcome).toBeInstanceOf(CouchHttpError);
      // (The leader election comes first, then the 300 ms bound on the wind-down;
      // without the bound this would not end at all.)
      expect(Date.now() - started).toBeLessThan(12_000);
    });

    it("and the replication that could not be wound down is not followed by a second of the same identifier: later cycles fail at once as 'no answer'", async () => {
      const store = await openBroken();
      couch.failNext = { status: 503, count: 1_000 };
      await store.runReplication(session()).catch(() => undefined);
      const calls = couch.calls.length;
      const again = Date.now();
      await expect(store.runReplication(session())).rejects.toMatchObject({
        name: "CouchHttpError",
        status: 0,
      });
      expect(Date.now() - again).toBeLessThan(100);
      // Nothing was sent for it, and the abandoned one sends nothing either.
      await new Promise((r) => setTimeout(r, 150));
      expect(couch.calls.length).toBe(calls);
    });

    it("closing the database does not wait for ever for a replication that cannot be wound down", async () => {
      const store = await openBroken();
      couch.failNext = { status: 503, count: 1_000 };
      await store.runReplication(session()).catch(() => undefined);
      const closed = await Promise.race([
        store.close().then(() => "closed"),
        new Promise((r) => setTimeout(() => r("hung"), 15_000)),
      ]);
      expect(closed).toBe("closed");
    });

    it("with the internal working, nothing is abandoned: the next cycle after a failure runs", async () => {
      const store = await open();
      couch.failNext = { status: 503, count: 100 };
      await store.runReplication(session()).catch(() => undefined);
      couch.failNext = null;
      await store.upsert(activity("livestock"));
      await store.runReplication(session());
      expect(couch.get("activity:livestock")).toBeDefined();
    });
  },
);
