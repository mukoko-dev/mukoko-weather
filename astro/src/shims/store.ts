/**
 * `@/lib/store` for this app (one of the five seams in astro.config.mjs).
 *
 * The real store (../../src/lib/store.ts) starts the RxDB bridge, which is the
 * 0.2 to 0.8 s of start-up and the heap the first screen should not pay for
 * (#551, finding 5). The shell needs six fields of it, and on a first visit
 * they are the defaults, so this answers with the defaults and no database.
 * Phase 1 replaces this file with the real store, loaded by the island that
 * needs it once the page has painted, and decides how the lane learns the
 * saved places without waiting for IndexedDB.
 *
 * Only the fields the shell's components select are here; a component that
 * selects another one fails the type check (`astro check`), because the
 * selector is typed against this shape.
 */
interface ShellState {
  locationLabels: Record<string, string>;
  locationNames: Record<string, string>;
  hiddenPresetSlugs: string[];
  presetAnchor: { lat: number; lon: number } | null;
  savedLocations: string[];
  selectedLocation: string;
}

const DEFAULTS: ShellState = {
  locationLabels: {},
  locationNames: {},
  hiddenPresetSlugs: [],
  presetAnchor: null,
  savedLocations: [],
  selectedLocation: "",
};

export function useAppStore<T>(selector: (state: ShellState) => T): T {
  return selector(DEFAULTS);
}
