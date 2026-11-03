/**
 * The options the sync database and its replication are created with, pinned.
 *
 * Why this is its own test. A real second tab cannot be started in this
 * environment: two RxDB databases with one name in one JavaScript process are
 * refused (DB9) outside dev mode, and the memory storage used here has no
 * second process to elect a leader against. So leader election itself is
 * RxDB's (and covered by the engine tests with a store that reports its
 * leadership); what this file pins is that we ASK for it: a database shared by
 * every tab (`multiInstance: true`, so tabs see each other's writes) and a
 * replication that waits for leadership (`waitForLeadership: true`), still
 * one-shot (`live: false`) because the gateway refuses continuous feeds.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";

const created = vi.hoisted(() => [] as Record<string, unknown>[]);
const replicated = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock("rxdb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("rxdb")>();
  return {
    ...actual,
    createRxDatabase: (opts: Record<string, unknown>) => {
      created.push(opts);
      return actual.createRxDatabase(opts as never);
    },
  };
});

vi.mock("rxdb/plugins/replication-couchdb", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("rxdb/plugins/replication-couchdb")>();
  return {
    ...actual,
    replicateCouchDB: (opts: Record<string, unknown>) => {
      replicated.push(opts);
      return actual.replicateCouchDB(opts as never);
    },
  };
});

import { openUserDocStore, SYNC_DB_PREFIX } from "./couch-rxdb";
import { FakeCouch } from "./test-support/couch-fake-server";

const PERSON = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const open: { close(): Promise<void> }[] = [];

afterEach(async () => {
  while (open.length) await open.pop()?.close();
  created.length = 0;
  replicated.length = 0;
});

describe("what the sync asks RxDB for", () => {
  it("a database shared by every tab: multiInstance true, one per person, never the app's own", async () => {
    const store = await openUserDocStore(PERSON, {
      storage: getRxStorageMemory() as never,
      nameSuffix: "_opt1",
    });
    if (!store) throw new Error("did not open");
    open.push(store);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      name: `${SYNC_DB_PREFIX}${PERSON}_opt1`,
      multiInstance: true,
    });
    expect(String(created[0].name)).not.toBe("mukoko_weather");
  });

  it("a replication that waits for leadership, one-shot, with leadership asked for explicitly", async () => {
    const token = "credential-for-tests-0123456789";
    const couch = new FakeCouch({ personId: PERSON, token });
    const store = await openUserDocStore(PERSON, {
      storage: getRxStorageMemory() as never,
      baseFetch: couch.fetch as typeof fetch,
      nameSuffix: "_opt2",
      retryTimeMs: 10,
      cycleTimeoutMs: 5_000,
    });
    if (!store) throw new Error("did not open");
    open.push(store);
    await store.runReplication({
      token,
      expiresInMs: 300_000,
      database: `user_${PERSON}`,
      personId: PERSON,
      databaseUrl: `https://api.test/v1/couch/db/user_${PERSON}/`,
    });
    expect(replicated).toHaveLength(1);
    expect(replicated[0]).toMatchObject({
      waitForLeadership: true,
      live: false,
    });
  });
});
