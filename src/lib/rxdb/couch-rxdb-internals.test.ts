/**
 * THE ONE RxDB INTERNAL the sync relies on, pinned against the installed
 * version (#396).
 *
 * What it is. RxDB's replication plugin retries a failed request for ever, and
 * for a non-live replication its `start()` only ends when the first sync does,
 * while `pause()` and `cancel()` are queued BEHIND that start. So a request that
 * keeps failing would deadlock the cancel, and with it the cycle, the engine's
 * queue, `stop()` and the pagehide. `endReplicationRetries` (couch-rxdb.ts) ends
 * the retry loops by flagging the replication as paused through
 * `state.internalReplicationState.events.paused`, which the plugin's own loops
 * (`while (!done && !this.isStoppedOrPaused())`) read; the start then finishes
 * and `cancel()` runs. There is no public API that does this.
 *
 * What these tests are for. Not to test RxDB: to FAIL LOUDLY, with words, when
 * an RxDB upgrade changes what `couch-rxdb.ts` stands on, so that someone looks
 * before a deadlock reaches a page. Even then the cycle cannot hang for ever:
 * the wait for `cancel()` is bounded (`couch-rxdb.test.ts`, "a cycle that
 * cannot be wound down never holds the page").
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { addRxPlugin, createRxDatabase, type RxDatabase } from "rxdb";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { replicateCouchDB } from "rxdb/plugins/replication-couchdb";
import { endReplicationRetries } from "./couch-rxdb";
import { RxDBLeaderElectionPlugin } from "rxdb/plugins/leader-election";

/**
 * The RxDB the internal was checked against (2026-11-04).
 *
 * 17.3.0 -> 17.6.0 re-check: the retry loops (`while (!done &&
 * !this.isStoppedOrPaused())` in the pull and push handlers), `isStoppedOrPaused`,
 * `internalReplicationState.events.paused` and the start/pause/cancel queue are
 * unchanged. The one behavioural change is that a failed `start()` no longer
 * leaves the queue rejected and is emitted on `error$` as `RC_START`; the
 * cycle in `couch-rxdb.ts` already ends and fails on ANY `error$` emission.
 */
const CHECKED_RXDB_VERSION = "17.6.0";

const WHAT_TO_RECHECK =
  "RxDB changed something `src/lib/rxdb/couch-rxdb.ts` relies on. Re-check " +
  "`endReplicationRetries` there: how a failing non-live replication is ended " +
  "(RxReplicationState.internalReplicationState.events.paused, read by the retry " +
  "loops of the pull and push handlers in rxdb/plugins/replication/index.js). " +
  "Then update CHECKED_RXDB_VERSION in this file.";

const dbs: RxDatabase[] = [];
afterEach(async () => {
  while (dbs.length) await dbs.pop()?.close();
});

let n = 0;
async function replicationThatKeepsFailing() {
  addRxPlugin(RxDBLeaderElectionPlugin);
  n += 1;
  const db = await createRxDatabase({
    name: `internals_${n}_${Date.now()}`,
    storage: getRxStorageMemory(),
    multiInstance: true,
  });
  dbs.push(db as unknown as RxDatabase);
  await db.addCollections({
    docs: {
      schema: {
        version: 0,
        primaryKey: "id",
        type: "object",
        properties: { id: { type: "string", maxLength: 40 } },
        required: ["id"],
      },
    },
  });
  let failures = 0;
  const state = replicateCouchDB<{ id: string }>({
    replicationIdentifier: `internals-${n}`,
    collection: (db as never as { docs: never }).docs,
    url: "https://api.test/db/",
    fetch: (async () => {
      failures += 1;
      throw new Error("down");
    }) as never,
    live: false,
    waitForLeadership: true,
    autoStart: true,
    retryTime: 20,
    pull: {},
    push: {},
  });
  // The first failure proves the retry loop is running.
  // (A replication waits for the leader election first: about half a second,
  // longer on a slow machine.)
  for (let i = 0; i < 800 && failures < 2; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(failures, WHAT_TO_RECHECK).toBeGreaterThanOrEqual(2);
  return { state, failures: () => failures };
}

const settlesWithin = (p: Promise<unknown>, ms: number) =>
  Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
  ]);

describe(
  "the RxDB internal behind endReplicationRetries",
  {
    timeout: 30_000,
  },
  () => {
    it("is the version it was checked against", () => {
      const installed = JSON.parse(
        readFileSync(
          resolve(__dirname, "../../../node_modules/rxdb/package.json"),
          "utf8",
        ),
      ) as { version: string };
      expect(
        installed.version,
        `rxdb is ${installed.version}, checked against ${CHECKED_RXDB_VERSION}. ${WHAT_TO_RECHECK}`,
      ).toBe(CHECKED_RXDB_VERSION);
    });

    it("still exists where we reach for it: a replication state with events.paused that can be set and read", async () => {
      const { state } = await replicationThatKeepsFailing();
      const paused = (
        state as unknown as {
          internalReplicationState?: {
            events?: {
              paused?: { next?: unknown; getValue?: unknown };
            };
          };
        }
      ).internalReplicationState?.events?.paused;
      expect(typeof paused?.next, WHAT_TO_RECHECK).toBe("function");
      expect(typeof paused?.getValue, WHAT_TO_RECHECK).toBe("function");
      endReplicationRetries(state);
      await settlesWithin(state.cancel(), 2_000);
    });

    it("is what ends a replication whose requests keep failing: cancel() then settles; without it, it does not", async () => {
      const stuck = await replicationThatKeepsFailing();
      // Control: the public cancel() alone never settles (it is queued behind a
      // start that waits for the first sync, which never comes).
      const unaided = stuck.state.cancel();
      expect(
        await settlesWithin(unaided, 400),
        "RxDB now ends a failing non-live replication by itself, or cancel() no longer waits for the start. " +
          WHAT_TO_RECHECK +
          " (The workaround may no longer be needed.)",
      ).toBe(false);

      // The workaround: the retry loops return, the start finishes, cancel runs.
      endReplicationRetries(stuck.state);
      expect(await settlesWithin(unaided, 3_000), WHAT_TO_RECHECK).toBe(true);
    });

    it("stops the retrying: no request is made after the replication is wound down", async () => {
      const run = await replicationThatKeepsFailing();
      endReplicationRetries(run.state);
      await settlesWithin(run.state.cancel(), 3_000);
      const after = run.failures();
      await new Promise((r) => setTimeout(r, 150));
      expect(run.failures(), WHAT_TO_RECHECK).toBe(after);
    });
  },
);
