/**
 * Starts the CouchDB sync for this page, once, if `FLAGS.couch_sync` is on.
 *
 * The flag is read FIRST. With it off (the default) this function returns
 * before importing the engine, RxDB's CouchDB plugin or the session client,
 * and before any request: `/api/couch/*` and the API host are never contacted.
 * `store.ts` reaches this file only through a dynamic `import()` behind the
 * same flag, so even the code of this file is not in a visitor's first-load
 * JavaScript. `couch-sync-flag-off.test.ts` guards both.
 *
 * The app's state comes in as a `SyncBridge` built by `store.ts`, so nothing
 * here imports the store.
 */

import { getFeatureFlag } from "../feature-flags";
import type { SyncBridge, Trigger } from "./couch-sync";

export interface CouchSyncHandle {
  stop(): Promise<void>;
}

let starting: Promise<CouchSyncHandle | null> | null = null;

/** Page events that should start a cycle: focus, becoming visible, going online. */
function pageTriggers(listener: (kind: Trigger) => void): () => void {
  const onFocus = () => listener("focus");
  const onVisibility = () => {
    if (document.visibilityState === "visible") listener("focus");
  };
  const onOnline = () => listener("online");
  window.addEventListener("focus", onFocus);
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/**
 * Start the sync. Resolves to a handle (call `stop()` on sign-out), or to
 * null when the flag is off, the page has no browser, or anything fails to
 * start: sync is an enhancement and never throws into the app. Idempotent.
 */
export function startCouchSync(
  bridge: SyncBridge,
  deviceId: string,
): Promise<CouchSyncHandle | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (!getFeatureFlag("couch_sync")) return Promise.resolve(null);
  if (starting) return starting;

  starting = (async () => {
    try {
      const [{ createCouchSyncEngine }, session, rxdb] = await Promise.all([
        import("./couch-sync"),
        import("./couch-session"),
        import("./couch-rxdb"),
      ]);
      const engine = createCouchSyncEngine({
        fetchSession: () => session.fetchCouchSession(),
        ensureDatabase: (s) => session.ensurePersonalDatabase(s),
        // Sign-out (401) and a different person remove the local database of
        // anyone but the signed-in person; see `couch-rxdb.ts`.
        purgeStores: (keep) => rxdb.purgeUserDocStores(keep),
        openStore: (personId) => rxdb.openUserDocStore(personId),
        bridge,
        deviceId,
        now: () => Date.now(),
        setTimer: (fn, ms) => window.setTimeout(fn, ms),
        clearTimer: (handle) => window.clearTimeout(handle as number),
        isVisible: () => document.visibilityState === "visible",
        isOnline: () => navigator.onLine !== false,
        onTrigger: pageTriggers,
      });
      await engine.start();

      // Tear down with the page: timers, listeners and the credential go, and
      // the local database closes. A page restored from the back/forward cache
      // is the same page coming back, so the engine starts again (it asks for
      // a new credential and takes a new baseline).
      const onPageHide = () => {
        void engine.stop();
      };
      const onPageShow = (event: Event) => {
        if ((event as PageTransitionEvent).persisted) void engine.start();
      };
      window.addEventListener("pagehide", onPageHide);
      window.addEventListener("pageshow", onPageShow);
      return {
        stop: async () => {
          window.removeEventListener("pagehide", onPageHide);
          window.removeEventListener("pageshow", onPageShow);
          await engine.stop();
          starting = null;
        },
      };
    } catch {
      starting = null;
      return null;
    }
  })();
  return starting;
}

/** For tests. */
export function _resetCouchSyncStart(): void {
  starting = null;
}
