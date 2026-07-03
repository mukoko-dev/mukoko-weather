import { useSyncExternalStore } from "react";

// A store that never emits — it exists only so `useSyncExternalStore` can
// return a different value for the server snapshot (`false`) than the client
// snapshot (`true`). React uses `getServerSnapshot` for SSR and the initial
// hydration render, then switches to `getSnapshot` in a post-hydration commit.
// This lets a component render a stable, deterministic placeholder on the
// server and first client render (identical HTML → no hydration mismatch /
// React error 418), then reveal client-only content (live clocks, "now"-
// relative slices) safely on the next render.
function subscribe(): () => void {
  return () => {};
}

/** Client snapshot — always `true` once running in the browser. */
export function getHydratedSnapshot(): boolean {
  return true;
}

/** Server snapshot — always `false` during SSR and the hydration render. */
export function getHydratedServerSnapshot(): boolean {
  return false;
}

/**
 * Returns `false` during SSR and the first client (hydration) render, then
 * `true` after hydration completes. Gate any value that differs between server
 * and client — e.g. `new Date()` — behind this so both sides render identical
 * HTML and no text-content hydration mismatch (React hydration error 418) occurs.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    getHydratedSnapshot,
    getHydratedServerSnapshot,
  );
}
