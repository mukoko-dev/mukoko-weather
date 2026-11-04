/**
 * The browser wiring of the person-preferences sync
 * (`person-preferences-sync.ts`): the device's real storage, store and clock.
 *
 * Reached only through a dynamic `import()` in `use-person-preferences-sync.ts`,
 * after first paint, and only for a signed-in person while the platform is
 * ready, so none of it is in a visitor's first-load JavaScript (the same
 * arrangement as `rxdb/couch-sync-start.ts`).
 *
 * Starts only after the device's own preferences have been loaded (a list read
 * before that would look like the person removing everything), then runs once,
 * again a moment after the activities change, and when the browser comes back
 * online after failing. Never throws into the app.
 */

import { getActivityById } from "./activities";
import {
  createPersonSyncController,
  readActivities,
  syncOnce,
  type SyncDeps,
  type SyncState,
} from "./person-preferences-sync";
import { readStorage, writeStorage } from "./safe-storage";
import {
  applySyncedPreferences,
  hasStoreHydrated,
  subscribeStoreHydrated,
  useAppStore,
} from "./store";

export const PERSON_SYNC_STATE_KEY = "mukoko-person-prefs";
/** After first paint, so it never competes with the weather. */
export const START_DELAY_MS = 3_000;
const MAX_OWNER_CHARS = 128;

/** The stored view, or null when absent or not one this code wrote. */
export function parseSyncState(raw: string | null): SyncState | null {
  if (!raw || raw.length > 64 * 1024) return null;
  try {
    const v = JSON.parse(raw) as { owner?: unknown; activities?: unknown };
    if (
      typeof v.owner !== "string" ||
      v.owner.length === 0 ||
      v.owner.length > MAX_OWNER_CHARS
    ) {
      return null;
    }
    return { owner: v.owner, activities: readActivities(v.activities) };
  } catch {
    return null;
  }
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/** `applying` is true while this module is writing the device's own list. */
function browserDeps(
  ownerId: string,
  applying: { current: boolean },
): SyncDeps {
  return {
    ownerId,
    now: () => Date.now(),
    readLocal: () => useAppStore.getState().selectedActivities,
    applyLocal: (ids) => {
      applying.current = true;
      try {
        // The store's own setter: also persists the list to the device's
        // preferences (RxDB), as if the person had changed it here.
        applySyncedPreferences({ selectedActivities: ids });
      } finally {
        applying.current = false;
      }
    },
    readState: () => parseSyncState(readStorage(PERSON_SYNC_STATE_KEY)),
    writeState: (state) => {
      writeStorage(PERSON_SYNC_STATE_KEY, JSON.stringify(state));
    },
    isKnownActivity: (id) => getActivityById(id) !== undefined,
    fetch: (url, init) => fetch(url, init),
  };
}

/** Start the sync for this person; the returned function stops it. */
export function startPersonPreferencesSync(ownerId: string): () => void {
  let disposed = false;
  let teardown: (() => void) | null = null;
  let unsubscribeHydrated: (() => void) | null = null;

  const begin = () => {
    if (disposed) return;
    const applying = { current: false };
    const deps = browserDeps(ownerId, applying);
    let first = true;
    const controller = createPersonSyncController(
      async () => {
        const outcome = await syncOnce(deps, { first });
        if (outcome.kind === "synced") first = false;
        return outcome;
      },
      {
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
        clearTimeout: (h) => window.clearTimeout(h as number),
      },
    );

    const unsubscribe = useAppStore.subscribe((state, prev) => {
      if (applying.current) return;
      if (!sameIds(state.selectedActivities, prev.selectedActivities)) {
        controller.localChanged();
      }
    });
    const onOnline = () => controller.online();
    window.addEventListener("online", onOnline);
    controller.start(START_DELAY_MS);

    teardown = () => {
      unsubscribe();
      window.removeEventListener("online", onOnline);
      controller.stop();
    };
  };

  // Wait for the device's own preferences to load before reading them.
  if (hasStoreHydrated()) {
    begin();
  } else {
    unsubscribeHydrated = subscribeStoreHydrated(() => {
      unsubscribeHydrated?.();
      unsubscribeHydrated = null;
      begin();
    });
  }

  return () => {
    disposed = true;
    unsubscribeHydrated?.();
    teardown?.();
  };
}
