import { create } from "zustand";
import { persist } from "zustand/middleware";
import { queueSync, flushSync, initDeviceSync, type DevicePreferences } from "./device-sync";

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
 * Module-level hydration flag — set by onRehydrateStorage once Zustand
 * finishes reading from localStorage. Components that depend on persisted
 * state (e.g. WelcomeBanner checking hasOnboarded) should wait for this
 * to avoid a flash of incorrect content.
 */
let _hasHydrated = false;

/** Check if the Zustand store has finished hydrating from localStorage. */
export function hasStoreHydrated(): boolean {
  return _hasHydrated;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      theme: "system" as ThemePreference,
      setTheme: (theme: ThemePreference) => {
        applyTheme(theme);
        set({ theme });
        queueSync({ theme });
      },
      toggleTheme: () =>
        set((state) => {
          const idx = THEME_CYCLE.indexOf(state.theme);
          const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
          applyTheme(next);
          queueSync({ theme: next });
          return { theme: next };
        }),
      selectedLocation: "harare",
      setSelectedLocation: (slug) => {
        set({ selectedLocation: slug });
        queueSync({ selectedLocation: slug });
      },
      savedLocations: [],
      saveLocation: (slug) =>
        set((state) => {
          if (state.savedLocations.includes(slug) || state.savedLocations.length >= MAX_SAVED_LOCATIONS) {
            return {};
          }
          const next = [...state.savedLocations, slug];
          queueSync({ savedLocations: next });
          return { savedLocations: next };
        }),
      removeLocation: (slug) =>
        set((state) => {
          const next = state.savedLocations.filter((s) => s !== slug);
          queueSync({ savedLocations: next });
          return { savedLocations: next };
        }),
      selectedActivities: [],
      toggleActivity: (id) =>
        set((state) => {
          const next = state.selectedActivities.includes(id)
            ? state.selectedActivities.filter((a) => a !== id)
            : [...state.selectedActivities, id];
          queueSync({ selectedActivities: next });
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
        queueSync({ hasOnboarded: true });
      },
      shamwariContext: null,
      setShamwariContext: (ctx) => set({ shamwariContext: { ...ctx, timestamp: Date.now() } }),
      clearShamwariContext: () => set({ shamwariContext: null }),
      reportModalOpen: false,
      openReportModal: () => set({ reportModalOpen: true }),
      closeReportModal: () => set({ reportModalOpen: false }),
    }),
    {
      name: "mukoko-weather-prefs",
      partialize: (state) => ({
        theme: state.theme,
        selectedLocation: state.selectedLocation,
        savedLocations: state.savedLocations,
        selectedActivities: state.selectedActivities,
        hasOnboarded: state.hasOnboarded,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.theme);
        _hasHydrated = true;
      },
    },
  ),
);

// ---------------------------------------------------------------------------
// Device sync initialization — runs once on client-side app load
// ---------------------------------------------------------------------------

/** Guard against duplicate beforeunload listeners (e.g. React Strict Mode). */
let _beforeUnloadRegistered = false;

/** Initialize device sync after Zustand rehydrates. */
export function initializeDeviceSync(): void {
  if (typeof window === "undefined") return;

  const getCurrentPrefs = (): DevicePreferences => {
    const s = useAppStore.getState();
    return {
      theme: s.theme,
      selectedLocation: s.selectedLocation,
      savedLocations: s.savedLocations,
      selectedActivities: s.selectedActivities,
      hasOnboarded: s.hasOnboarded,
    };
  };

  const applyPrefs = (prefs: DevicePreferences): void => {
    const store = useAppStore.getState();

    if (prefs.theme && prefs.theme !== store.theme) {
      store.setTheme(prefs.theme as ThemePreference);
    }
    if (prefs.selectedLocation && prefs.selectedLocation !== store.selectedLocation) {
      // Use setState directly to avoid re-triggering sync
      useAppStore.setState({ selectedLocation: prefs.selectedLocation });
    }
    if (prefs.savedLocations && prefs.savedLocations.length > 0) {
      useAppStore.setState({ savedLocations: prefs.savedLocations });
    }
    if (prefs.selectedActivities && prefs.selectedActivities.length > 0) {
      useAppStore.setState({ selectedActivities: prefs.selectedActivities });
    }
    if (prefs.hasOnboarded) {
      useAppStore.setState({ hasOnboarded: true });
    }
  };

  initDeviceSync(getCurrentPrefs, applyPrefs);

  // Flush pending syncs before the page unloads (guard against duplicate registration)
  if (!_beforeUnloadRegistered) {
    _beforeUnloadRegistered = true;
    window.addEventListener("beforeunload", flushSync);
  }
}
