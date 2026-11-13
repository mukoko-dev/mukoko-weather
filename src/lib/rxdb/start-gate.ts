/**
 * When the on-device database may start on the home page.
 *
 * Opening RxDB means fetching and running about 350 KB of JavaScript (RxDB,
 * Dexie, the schema migration and the query engine), opening IndexedDB and
 * creating the collections. On a mid-range phone that is most of a second of
 * main-thread work, and the home page does not need it to show the weather:
 * the place and its last forecast are read from one localStorage key
 * (`home-snapshot.ts`) and the theme from another (`theme.ts`). So on `/` the
 * work that is not needed to paint waits for the weather to be on screen and
 * for the browser to be idle, and then runs (issue 551).
 *
 * Only background work waits here: the preferences bridge, the write-back of
 * the forecast and the weather hint, and the replication that follows the
 * bridge. A reader that wants a stored place to paint (`recallPlace`) opens
 * the database at once, as before, and so does any other page: the gate is
 * armed only for `/`, and anything else resolves immediately.
 *
 * The wait is bounded: if the weather never paints (an error, offline with
 * nothing stored) the gate lets go after `STORAGE_MAX_HOLD_MS`, so the
 * preferences still load. Once let go it stays open for the life of the page.
 */
import { afterPaintWhenIdle } from "../weather-scenes/start-gate";

/** The only page that holds storage back: the home page. */
export const HOME_PATH = "/";

/** The longest the home page holds background storage work back. */
export const STORAGE_MAX_HOLD_MS = 5000;

let held = false;
let released = false;
let waiting: Array<() => void> = [];
let timer: ReturnType<typeof setTimeout> | undefined;

/**
 * Ask background storage work to wait for the first screen. A no-op anywhere
 * but the home page, on the server, and once the gate has been let go.
 */
export function holdStorageForFirstScreen(pathname: string): void {
  if (held || released || typeof window === "undefined") return;
  if (pathname !== HOME_PATH) return;
  held = true;
  timer = setTimeout(releaseStorage, STORAGE_MAX_HOLD_MS);
}

/** Let background storage work start now, and for good. */
export function releaseStorage(): void {
  if (released) return;
  released = true;
  held = false;
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  const resume = waiting;
  waiting = [];
  for (const go of resume) go();
}

/**
 * Let go once the weather has painted (two frames) and the browser is idle.
 * Returns the canceller for an effect clean-up; the time limit still applies
 * if it fires. Not conditional on the gate being armed yet: the dashboard's
 * effect can run before the effect that arms the gate (child effects run
 * first), and a gate released before it was armed is never armed.
 */
export function releaseStorageAfterPaint(): () => void {
  if (released || typeof window === "undefined") return () => {};
  return afterPaintWhenIdle(releaseStorage);
}

/** True while the home page is holding background storage work back. */
export function isStorageHeld(): boolean {
  return held;
}

/**
 * Resolves when background work that the first screen does not need may start:
 * at once unless the home page is holding it back, else when its weather has
 * painted and the browser is idle (or after the time limit). Storage waits
 * here, and so does analytics (`GoogleAnalytics.tsx`).
 */
export function storageMayStart(): Promise<void> {
  if (!held) return Promise.resolve();
  return new Promise((resolve) => {
    waiting.push(resolve);
  });
}

/** Tests only: back to a fresh page. */
export function _resetStartGate(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  held = false;
  released = false;
  waiting = [];
}

// Armed as soon as this module loads in the browser, before React has rendered
// anything: an effect further down the tree (the dashboard's write-back runs
// before the provider's own, children first) must already find the gate shut.
// Anywhere but the home page, and on the server, this does nothing.
if (typeof window !== "undefined") {
  holdStorageForFirstScreen(window.location?.pathname ?? "");
}
