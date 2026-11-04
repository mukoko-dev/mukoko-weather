/**
 * Make a signed-in person's activities follow them (mukoko-dev/mukoko-weather#484),
 * without ever making it a requirement.
 *
 * Local first. The device keeps working from its own preferences (RxDB, then
 * the store) whatever happens here. When the person is signed in, this module
 * reads their profile (`GET /api/profile/preferences`), merges it with what is
 * on the device, writes the difference, and applies the result locally. Signed
 * out, offline, or while the server says it is not ready, nothing changes and
 * nothing is sent. Anonymous visitors store nothing on the server.
 *
 * Pure with injected dependencies (the fetch, the clock, storage, the store),
 * so every rule is tested in node. `person-preferences-sync-start.ts` supplies
 * the browser ones.
 *
 * THE RULES
 *   1. A device list has no timestamps, so the device keeps the last merged
 *      view (`SyncState`, with every item's `updatedAt` and tombstone). What
 *      the person did since is the difference between the list on the device
 *      and that view: an id added now is a live item stamped now (a removed
 *      one revives; one already live on the profile is left as it is), an id
 *      gone is a tombstone stamped now. The stamp is the time of the pass that
 *      noticed the change, which can be later than the edit; the cost is that
 *      a removal noticed late can beat a newer add on another device. The
 *      device list is taken as the person's, whoever wrote it on this device.
 *   2. Merge per item with the server's items: the later `updatedAt` wins, a
 *      tie leaves the server's item. An item is never dropped only because the
 *      other side lacks it, so an empty profile never empties the device and an
 *      empty device never empties the profile.
 *   3. Over the cap (`MAX_PERSON_ACTIVITIES`) the person's existing items come
 *      first; device-only extras stay on the device and are not sent. They are
 *      reported, not dropped quietly: the pass's result lists them as
 *      `overflow` (and `person-preferences-state.ts` keeps the latest list).
 *      Nothing on screen says so yet, and nothing stops the selection at the
 *      cap; a limit at selection time is a separate UI change.
 *   4. The view is tagged with the person who last synced it. A DIFFERENT
 *      person signing in on the same browser does not merge the previous
 *      person's selections into their profile: the device list becomes their
 *      profile (which may be empty). A device with no view at all (never
 *      synced, or storage that cannot keep one) is anonymous: its selections
 *      are the first person's to take, except that an item the profile
 *      already removed stays removed, because nothing on the device says it
 *      saw that removal.
 *   5. Only catalogue activity ids are sent or applied (`isKnownActivity`).
 *      Ids from a newer app stay in the view, untouched, and are never shown.
 *   6. Sign-out leaves the view and the stored profile alone.
 *   7. One retry schedule: a failure backs off 30 s doubling to 15 min,
 *      a 429 waits for `Retry-After`, and a refusal that will not change
 *      (signed out, not ready, not found, a request this code should not have
 *      made) stops for the page. A 422 does not stop it: one refused item
 *      must not silence every later edit, and the backoff bounds the traffic.
 *      Changes made while a run is in flight are folded into one more run.
 *   8. The first pass of a page load that finds the device list EMPTY while
 *      the last view had activities does not read that as the person removing
 *      everything: it is far more likely storage that was lost (Safari's
 *      seven-day wipe, a private window), and the profile must survive it. The
 *      profile's items come back instead. Later passes, which watch the person
 *      edit, treat an emptied list as the removal it is. The cost: removing
 *      the last activity and closing the page inside the two-second debounce
 *      brings it back once.
 *   9. A view older than the tombstone retention (30 days) cannot vouch for an
 *      item the profile no longer has: the removal may have been purged since.
 *      Such an item is treated as removed elsewhere, not pushed back.
 *
 * Saved places are not here: they are encrypted on the device (ADR-0002) and
 * the key that would encrypt them has no home yet.
 */

import {
  ACTIVITY_ID_RE,
  MAX_PERSON_ACTIVITIES,
  TOMBSTONE_RETENTION_MS,
  activityIdOf,
  mergeById,
  type ActivityItem,
} from "./person-preferences";
import { isWireTimestamp } from "./rxdb/couch-docs";

export const PERSON_PREFERENCES_URL = "/api/profile/preferences";

/** The last merged view and the person it belongs to. */
export interface SyncState {
  owner: string;
  activities: ActivityItem[];
  /** When this view was last confirmed by the server (RFC 3339). */
  syncedAt?: string;
}

export interface SyncDeps {
  /** The signed-in person (the WorkOS user id). */
  ownerId: string;
  now: () => number;
  /** The activity ids selected on this device. */
  readLocal: () => string[];
  /** Replace the device's selected activities (also persists them). */
  applyLocal: (ids: string[]) => void;
  readState: () => SyncState | null;
  writeState: (state: SyncState) => void;
  isKnownActivity: (id: string) => boolean;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}

export type SyncOutcome =
  /**
   * `overflow` is a known state, not a silent drop: the device's activities
   * beyond the profile's cap (rule 3). They stay on this device and are not on
   * the profile, so they do not follow the person. Empty when all fit.
   */
  | { kind: "synced"; overflow: string[] }
  /** Try again later: the network, a 5xx, a 429 or a refused batch (422). */
  | { kind: "retry"; afterMs?: number }
  /** Will not change by waiting: stop for this page load. */
  | { kind: "stopped"; reason: string };

// ---------------------------------------------------------------------------
// Shapes read back from the server or from storage (never trusted)
// ---------------------------------------------------------------------------

/** The activities of a document or a stored view; entries that do not fit are dropped. */
export function readActivities(raw: unknown): ActivityItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ActivityItem[] = [];
  for (const v of raw) {
    if (typeof v !== "object" || v === null) continue;
    const r = v as Record<string, unknown>;
    if (
      typeof r.activityId === "string" &&
      ACTIVITY_ID_RE.test(r.activityId) &&
      isWireTimestamp(r.createdAt) &&
      isWireTimestamp(r.updatedAt) &&
      typeof r.tombstone === "boolean"
    ) {
      out.push({
        activityId: r.activityId,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        tombstone: r.tombstone,
      });
    }
  }
  return out.slice(0, 200);
}

// ---------------------------------------------------------------------------
// The merge (pure)
// ---------------------------------------------------------------------------

export interface Reconciled {
  /** The merged items, over-cap extras left out. */
  merged: ActivityItem[];
  /** What the server does not have yet: send these. */
  push: ActivityItem[];
  /** Device-only ids beyond the cap: kept on the device, never sent. */
  overflow: Set<string>;
}

/** Rule 1: the device's list as items, on top of the last merged view. */
function deviceView(args: {
  base: readonly ActivityItem[];
  /** Whether the device has a view of its own at all (rule 4). */
  hasView: boolean;
  local: readonly string[];
  remote: readonly ActivityItem[];
  nowIso: string;
  isKnown: (id: string) => boolean;
  guardEmpty: boolean;
  /** Rule 9: ids the profile no longer has, that a stale view cannot vouch for. */
  lost: ReadonlySet<string>;
}): ActivityItem[] {
  const { base, hasView, remote, nowIso, isKnown, lost } = args;
  const byId = new Map(base.map((i) => [i.activityId, i]));
  const onServer = new Map(remote.map((i) => [i.activityId, i]));
  const known = args.local.filter(isKnown);
  // Rule 8: an empty list on a first pass is storage lost, not a removal.
  const present = new Set(
    args.guardEmpty && known.length === 0
      ? base
          .filter((i) => !i.tombstone && isKnown(i.activityId))
          .map(activityIdOf)
      : known,
  );
  for (const id of lost) present.delete(id);
  for (const id of present) {
    const item = byId.get(id);
    if (!item || item.tombstone) {
      const there = onServer.get(id);
      if (there && !there.tombstone) {
        // Already live on the profile: nothing to say, so no new stamp (a
        // stamp would only reorder it against another device's later removal).
        byId.set(id, there);
      } else if (!item && !hasView && there?.tombstone) {
        // Rule 4: nothing on this device saw that removal, so it stands.
        byId.set(id, there);
      } else {
        byId.set(id, {
          activityId: id,
          createdAt: item?.createdAt ?? there?.createdAt ?? nowIso,
          updatedAt: nowIso,
          tombstone: false,
        });
      }
    }
  }
  for (const [id, item] of byId) {
    // Only an id this app knows was ever on the device to be removed.
    if (!item.tombstone && isKnown(id) && !present.has(id)) {
      byId.set(id, { ...item, updatedAt: nowIso, tombstone: true });
    }
  }
  return [...byId.values()];
}

export function reconcile(args: {
  local: readonly string[];
  state: SyncState | null;
  ownerId: string;
  remote: readonly ActivityItem[];
  nowIso: string;
  isKnown: (id: string) => boolean;
  /** Rule 8: this is the first pass of the page load. */
  first: boolean;
}): Reconciled & { foreign: boolean } {
  const { remote } = args;
  // Rule 4: a view that belongs to someone else is not this person's.
  const foreign = args.state !== null && args.state.owner !== args.ownerId;
  const own = args.state !== null && !foreign ? args.state : null;

  // Rule 9: a view this old cannot vouch for an item the profile lacks.
  const lost = new Set<string>();
  if (
    own?.syncedAt !== undefined &&
    Date.parse(args.nowIso) - Date.parse(own.syncedAt) > TOMBSTONE_RETENTION_MS
  ) {
    const onProfile = new Set(remote.map(activityIdOf));
    for (const item of own.activities) {
      if (!item.tombstone && !onProfile.has(item.activityId)) {
        lost.add(item.activityId);
      }
    }
  }

  const view = foreign
    ? []
    : deviceView({
        base: own?.activities ?? [],
        hasView: own !== null,
        local: args.local,
        remote,
        nowIso: args.nowIso,
        isKnown: args.isKnown,
        guardEmpty: args.first,
        lost,
      });

  // Rule 2: per item, the later wins and a tie leaves the server's item.
  let merged = mergeById(remote, view, activityIdOf);

  // Rule 3: the person's existing items first, then the device's extras.
  const overflow = new Set<string>();
  const live = merged.filter((i) => !i.tombstone);
  if (live.length > MAX_PERSON_ACTIVITIES) {
    const existing = new Set(
      remote.filter((i) => !i.tombstone).map(activityIdOf),
    );
    const ordered = [...live].sort(
      (a, b) =>
        Number(!existing.has(a.activityId)) -
          Number(!existing.has(b.activityId)) ||
        (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0),
    );
    for (const extra of ordered.slice(MAX_PERSON_ACTIVITIES)) {
      overflow.add(extra.activityId);
    }
    merged = merged.filter((i) => !overflow.has(i.activityId));
  }

  const remoteById = new Map(remote.map((i) => [i.activityId, i]));
  const push = merged.filter((m) => {
    const r = remoteById.get(m.activityId);
    // A removal the server never saw the item for is not worth sending.
    if (!r) return !m.tombstone;
    return r.updatedAt !== m.updatedAt || r.tombstone !== m.tombstone;
  });
  return { merged, push, overflow, foreign };
}

/**
 * The device's new list: its own order first, then what arrived. `added` and
 * `removed` are what the person changed on the device while the request was in
 * the air: a late add stays (the next pass sends it), a late removal is not
 * undone by an answer that still had the item.
 */
export function projectLocal(args: {
  local: readonly string[];
  items: readonly ActivityItem[];
  overflow: ReadonlySet<string>;
  foreign: boolean;
  isKnown: (id: string) => boolean;
  added?: readonly string[];
  removed?: ReadonlySet<string>;
}): string[] {
  const live = args.items
    .filter((i) => !i.tombstone && args.isKnown(i.activityId))
    .map(activityIdOf);
  const liveSet = new Set(live);
  const out: string[] = [];
  const seen = new Set<string>();
  const take = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  if (!args.foreign) {
    for (const id of args.local) {
      // Dropped when removed elsewhere; kept when it is not known to this app,
      // is beyond the cap, or was added while the request was in the air.
      if (
        liveSet.has(id) ||
        args.overflow.has(id) ||
        !args.isKnown(id) ||
        args.added?.includes(id)
      ) {
        take(id);
      }
    }
  } else {
    for (const id of args.added ?? []) take(id);
  }
  for (const id of live) {
    if (!args.removed?.has(id)) take(id);
  }
  return out;
}

export const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

// ---------------------------------------------------------------------------
// One pass: read, merge, write the difference, apply
// ---------------------------------------------------------------------------

type Call =
  | { ok: true; activities: ActivityItem[] }
  | { ok: false; outcome: SyncOutcome };

async function call(
  deps: SyncDeps,
  method: "GET" | "PUT",
  body?: unknown,
): Promise<Call> {
  let res: Response;
  try {
    res = await deps.fetch(PERSON_PREFERENCES_URL, {
      method,
      credentials: "same-origin",
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
  } catch {
    return { ok: false, outcome: { kind: "retry" } };
  }
  if (res.ok) {
    try {
      const doc: unknown = await res.json();
      const list = (doc as { activities?: unknown } | null)?.activities;
      return { ok: true, activities: readActivities(list) };
    } catch {
      return { ok: false, outcome: { kind: "retry" } };
    }
  }
  if (res.status === 429) {
    const seconds = Number(res.headers.get("retry-after"));
    return {
      ok: false,
      outcome: {
        kind: "retry",
        afterMs:
          Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined,
      },
    };
  }
  if (res.status === 503) {
    let code = "";
    try {
      code = String(((await res.json()) as { code?: unknown }).code ?? "");
    } catch {
      code = "";
    }
    // "Not available yet" does not change by waiting; an outage does.
    return {
      ok: false,
      outcome:
        code === "preferences_unavailable"
          ? { kind: "stopped", reason: code }
          : { kind: "retry" },
    };
  }
  // A 422 is one refused item (rule 7): back off, but do not go silent.
  if (res.status >= 500 || res.status === 408 || res.status === 422) {
    return { ok: false, outcome: { kind: "retry" } };
  }
  // 401 (signed out), 403, 404 (no record), other 4xx (a request this code
  // should not have made): will not change by waiting.
  return {
    ok: false,
    outcome: { kind: "stopped", reason: String(res.status) },
  };
}

export async function syncOnce(
  deps: SyncDeps,
  options: { first: boolean } = { first: false },
): Promise<SyncOutcome> {
  const got = await call(deps, "GET");
  if (!got.ok) return got.outcome;

  const nowIso = new Date(deps.now()).toISOString();
  const local = deps.readLocal();
  const r = reconcile({
    local,
    state: deps.readState(),
    ownerId: deps.ownerId,
    remote: got.activities,
    nowIso,
    isKnown: deps.isKnownActivity,
    first: options.first,
  });

  let items = r.merged;
  if (r.push.length > 0) {
    const put = await call(deps, "PUT", { activities: r.push });
    if (!put.ok) return put.outcome;
    // The server's answer is the truth, in the order it settled it.
    items = put.activities;
  }

  const cutoff = new Date(deps.now() - TOMBSTONE_RETENTION_MS).toISOString();
  deps.writeState({
    owner: deps.ownerId,
    activities: items.filter((i) => !(i.tombstone && i.updatedAt < cutoff)),
    syncedAt: nowIso,
  });

  // The device may have changed while the requests were in the air: judge the
  // list against what is there now, so a late edit is not overwritten.
  const current = deps.readLocal();
  const before = new Set(local);
  const after = new Set(current);
  const next = projectLocal({
    local: current,
    items,
    overflow: r.overflow,
    foreign: r.foreign,
    isKnown: deps.isKnownActivity,
    added: current.filter((id) => !before.has(id)),
    removed: new Set(local.filter((id) => !after.has(id))),
  });
  if (!sameList(current, next)) deps.applyLocal(next);
  return { kind: "synced", overflow: [...r.overflow].sort() };
}

// ---------------------------------------------------------------------------
// When to run: start, a change (debounced), coming back online
// ---------------------------------------------------------------------------

export interface Scheduler {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export const SYNC_DEBOUNCE_MS = 2_000;
export const SYNC_BACKOFF_FIRST_MS = 30_000;
export const SYNC_BACKOFF_MAX_MS = 15 * 60_000;

export const backoffMs = (failures: number): number =>
  Math.min(
    SYNC_BACKOFF_MAX_MS,
    SYNC_BACKOFF_FIRST_MS * 2 ** Math.max(0, failures - 1),
  );

export interface PersonSyncController {
  /** Run once after `initialDelayMs`. */
  start(initialDelayMs: number): void;
  /** The device's activities changed (not by this module). */
  localChanged(): void;
  /** The browser came back online. */
  online(): void;
  stop(): void;
}

export function createPersonSyncController(
  run: () => Promise<SyncOutcome>,
  scheduler: Scheduler,
): PersonSyncController {
  let timer: unknown = null;
  let running = false;
  let dirty = false;
  let failures = 0;
  let stopped = false;

  const clear = () => {
    if (timer !== null) scheduler.clearTimeout(timer);
    timer = null;
  };
  const schedule = (ms: number) => {
    clear();
    timer = scheduler.setTimeout(() => {
      timer = null;
      void pass();
    }, ms);
  };

  async function pass(): Promise<void> {
    if (stopped) return;
    if (running) {
      dirty = true;
      return;
    }
    running = true;
    let outcome: SyncOutcome;
    try {
      outcome = await run();
    } catch {
      outcome = { kind: "retry" };
    }
    running = false;
    if (stopped) return;
    if (outcome.kind === "stopped") {
      stopped = true;
      clear();
    } else if (outcome.kind === "retry") {
      failures += 1;
      schedule(Math.max(outcome.afterMs ?? 0, backoffMs(failures)));
    } else {
      failures = 0;
      if (dirty) schedule(SYNC_DEBOUNCE_MS);
    }
    dirty = false;
  }

  return {
    start: (initialDelayMs) => {
      if (!stopped) schedule(initialDelayMs);
    },
    localChanged: () => {
      if (stopped) return;
      if (running) {
        dirty = true;
        return;
      }
      // While backing off, the pending retry will carry this change too.
      if (failures > 0) return;
      schedule(SYNC_DEBOUNCE_MS);
    },
    online: () => {
      // Only a run that was failing has a reason to hurry.
      if (stopped || running || failures === 0) return;
      schedule(1_000);
    },
    stop: () => {
      stopped = true;
      clear();
    },
  };
}
