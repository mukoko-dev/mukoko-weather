import { create } from "zustand";
import { updatePreferences, initRxDBBridge } from "./rxdb/bridge";
import { startReplication } from "./rxdb/replication";
import type { PreferencesDocType } from "./rxdb/schemas";

export type ThemePreference = "light" | "dark" | "system";

// ---------------------------------------------------------------------------
// Shamwari context — carries weather/location/summary data between pages
// ---------------------------------------------------------------------------

const SHAMWARI_CONTEXT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface ShamwariContext {
  source: "location" | "explore" | "history";
  locationSlug?: string;
  locationName?: string;
  province?: string;
  weatherSummary?: string;
  temperature?: number;
  condition?: string;
  season?: string;
  activities: string[];
  /** History-specific context */
  historyDays?: number;
  historyAnalysis?: string;
  /** Explore-specific context */
  exploreQuery?: string;
  /** Set automatically — context expires after 10 minutes */
  timestamp: number;
}

/** Check if a Shamwari context is still valid (< 10 min old) */
export function isShamwariContextValid(ctx: ShamwariContext | null): ctx is ShamwariContext {
  if (!ctx) return false;
  return Date.now() - ctx.timestamp < SHAMWARI_CONTEXT_TTL_MS;
}

/** Resolve the effective theme (light/dark) for a given preference */
export function resolveTheme(pref: ThemePreference): "light" | "dark" {
  if (pref !== "system") return pref;
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Apply the resolved theme to the DOM */
function applyTheme(pref: ThemePreference) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", resolveTheme(pref));
  document.documentElement.setAttribute("data-brand", "mukoko-weather");
}

/** Maximum number of saved locations per user */
export const MAX_SAVED_LOCATIONS = 10;

interface AppState {
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  toggleTheme: () => void;
  selectedLocation: string; // slug — currently viewed location
  setSelectedLocation: (slug: string) => void;
  /** Saved locations list (up to MAX_SAVED_LOCATIONS slugs, ordered) */
  savedLocations: string[];
  /** Add a location to saved list (no-op if already saved or at cap) */
  saveLocation: (slug: string) => void;
  /** Remove a location from saved list */
  removeLocation: (slug: string) => void;
  /** Custom labels for saved locations (e.g., "Home", "Work") — keyed by slug */
  locationLabels: Record<string, string>;
  /** Set a custom label for a saved location */
  setLocationLabel: (slug: string, label: string) => void;
  selectedActivities: string[]; // activity IDs from src/lib/activities.ts
  toggleActivity: (id: string) => void;
  myWeatherOpen: boolean;
  openMyWeather: () => void;
  closeMyWeather: () => void;
  /** Saved locations modal visibility (transient) */
  savedLocationsOpen: boolean;
  openSavedLocations: () => void;
  closeSavedLocations: () => void;
  hasOnboarded: boolean;
  completeOnboarding: () => void;
  /** Shamwari context — carries weather/location data between pages (transient, not persisted) */
  shamwariContext: ShamwariContext | null;
  /** Accepts context with optional timestamp — auto-sets timestamp to Date.now() */
  setShamwariContext: (ctx: Omit<ShamwariContext, "timestamp"> & { timestamp?: number }) => void;
  clearShamwariContext: () => void;
  /** Weather report modal visibility (transient) */
  reportModalOpen: boolean;
  openReportModal: () => void;
  closeReportModal: () => void;
}

const THEME_CYCLE: ThemePreference[] = ["light", "dark", "system"];

/**
 * Module-level hydration flag — set once RxDB bridge finishes loading
 * preferences into the store. Components that depend on persisted state
 * (e.g. WelcomeBanner checking hasOnboarded) should wait for this to
 * avoid a flash of incorrect content.
 */
let _hasHydrated = false;

/** Check if the Zustand store has finished hydrating from RxDB. */
export function hasStoreHydrated(): boolean {
  return _hasHydrated;
}

// ---------------------------------------------------------------------------
// Flag to suppress RxDB writes during bridge hydration (prevents echo loop)
// ---------------------------------------------------------------------------
let _suppressRxDBWrites = false;

export const useAppStore = create<AppState>()((set) => ({
  theme: "system" as ThemePreference,
  setTheme: (theme: ThemePreference) => {
    applyTheme(theme);
    set({ theme });
    if (!_suppressRxDBWrites) updatePreferences({ theme });
  },
  toggleTheme: () =>
    set((state) => {
      const idx = THEME_CYCLE.indexOf(state.theme);
      const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
      applyTheme(next);
      if (!_suppressRxDBWrites) updatePreferences({ theme: next });
      return { theme: next };
    }),
  selectedLocation: "",
  setSelectedLocation: (slug) => {
    set({ selectedLocation: slug });
    if (!_suppressRxDBWrites) updatePreferences({ selectedLocation: slug });
  },
  savedLocations: [],
  saveLocation: (slug) =>
    set((state) => {
      if (state.savedLocations.includes(slug) || state.savedLocations.length >= MAX_SAVED_LOCATIONS) {
        return {};
      }
      const next = [...state.savedLocations, slug];
      if (!_suppressRxDBWrites) updatePreferences({ savedLocations: next });
      return { savedLocations: next };
    }),
  removeLocation: (slug) =>
    set((state) => {
      const next = state.savedLocations.filter((s) => s !== slug);
      const { [slug]: _, ...remainingLabels } = state.locationLabels;
      if (!_suppressRxDBWrites) updatePreferences({ savedLocations: next, locationLabels: remainingLabels });
      return { savedLocations: next, locationLabels: remainingLabels };
    }),
  locationLabels: {},
  setLocationLabel: (slug, label) =>
    set((state) => {
      const trimmed = label.trim();
      let nextLabels: Record<string, string>;
      if (trimmed) {
        nextLabels = { ...state.locationLabels, [slug]: trimmed };
      } else {
        const { [slug]: _, ...rest } = state.locationLabels;
        nextLabels = rest;
      }
      if (!_suppressRxDBWrites) updatePreferences({ locationLabels: nextLabels });
      return { locationLabels: nextLabels };
    }),
  selectedActivities: [],
  toggleActivity: (id) =>
    set((state) => {
      const next = state.selectedActivities.includes(id)
        ? state.selectedActivities.filter((a) => a !== id)
        : [...state.selectedActivities, id];
      if (!_suppressRxDBWrites) updatePreferences({ selectedActivities: next });
      return { selectedActivities: next };
    }),
  myWeatherOpen: false,
  openMyWeather: () => set({ myWeatherOpen: true }),
  closeMyWeather: () => set({ myWeatherOpen: false }),
  savedLocationsOpen: false,
  openSavedLocations: () => set({ savedLocationsOpen: true }),
  closeSavedLocations: () => set({ savedLocationsOpen: false }),
  hasOnboarded: false,
  completeOnboarding: () => {
    set({ hasOnboarded: true });
    if (!_suppressRxDBWrites) updatePreferences({ hasOnboarded: true });
  },
  shamwariContext: null,
  setShamwariContext: (ctx) => set({ shamwariContext: { ...ctx, timestamp: Date.now() } }),
  clearShamwariContext: () => set({ shamwariContext: null }),
  reportModalOpen: false,
  openReportModal: () => set({ reportModalOpen: true }),
  closeReportModal: () => set({ reportModalOpen: false }),
}));

// ---------------------------------------------------------------------------
// RxDB initialization — replaces old device-sync + persist middleware
// ---------------------------------------------------------------------------

/**
 * Initialize the local-first storage layer:
 *   1. RxDB bridge: migrates localStorage → IndexedDB, hydrates Zustand
 *   2. Replication: bidirectional sync with Python backend
 *
 * Call once from a client-side layout/provider component.
 */
export function initializeDeviceSync(): void {
  if (typeof window === "undefined") return;

  initRxDBBridge({
    applyToStore: (prefs: Partial<PreferencesDocType>) => {
      _suppressRxDBWrites = true;
      try {
        if (prefs.theme !== undefined) {
          applyTheme(prefs.theme as ThemePreference);
          useAppStore.setState({ theme: prefs.theme as ThemePreference });
        }
        if (prefs.selectedLocation !== undefined) {
          useAppStore.setState({ selectedLocation: prefs.selectedLocation });
        }
        if (prefs.savedLocations !== undefined) {
          useAppStore.setState({ savedLocations: prefs.savedLocations });
        }
        if (prefs.locationLabels !== undefined) {
          useAppStore.setState({ locationLabels: prefs.locationLabels });
        }
        if (prefs.selectedActivities !== undefined) {
          useAppStore.setState({ selectedActivities: prefs.selectedActivities });
        }
        if (prefs.hasOnboarded !== undefined) {
          useAppStore.setState({ hasOnboarded: prefs.hasOnboarded });
        }
      } finally {
        _suppressRxDBWrites = false;
      }
    },

    getCurrentPrefs: () => {
      const s = useAppStore.getState();
      return {
        theme: s.theme,
        selectedLocation: s.selectedLocation,
        savedLocations: s.savedLocations,
        locationLabels: s.locationLabels,
        selectedActivities: s.selectedActivities,
        hasOnboarded: s.hasOnboarded,
      };
    },
  })
    .then(() => {
      _hasHydrated = true;
      return startReplication();
    })
    .catch(() => {
      // RxDB init failed — store still works with defaults.
      // This handles cases like private browsing where IndexedDB may be unavailable.
      _hasHydrated = true;
    });
}
