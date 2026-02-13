import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type ThemePreference = "light" | "dark" | "system";

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

interface AppState {
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  toggleTheme: () => void;
  selectedLocation: string; // slug
  setSelectedLocation: (slug: string) => void;
  selectedActivities: string[]; // activity IDs from src/lib/activities.ts
  toggleActivity: (id: string) => void;
}

const THEME_CYCLE: ThemePreference[] = ["light", "dark", "system"];

/**
 * Safe localStorage wrapper that never throws.
 *
 * iOS Safari in Private Browsing mode throws QuotaExceededError or
 * SecurityError on ANY localStorage access — getItem, setItem, and
 * removeItem can all throw. Zustand's default persist storage doesn't
 * wrap these in try-catch, so the unhandled exception crashes React
 * during hydration and creates an infinite reload loop.
 *
 * We wrap the raw Storage object and pass it to createJSONStorage so
 * Zustand handles the JSON serialization layer on top.
 */
const safeLocalStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
  getItem(name: string): string | null {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem(name: string, value: string): void {
    try {
      localStorage.setItem(name, value);
    } catch {
      // localStorage unavailable (iOS private browsing, quota exceeded)
    }
  },
  removeItem(name: string): void {
    try {
      localStorage.removeItem(name);
    } catch {
      // localStorage unavailable
    }
  },
};

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      theme: "system" as ThemePreference,
      setTheme: (theme: ThemePreference) => {
        applyTheme(theme);
        set({ theme });
      },
      toggleTheme: () =>
        set((state) => {
          const idx = THEME_CYCLE.indexOf(state.theme);
          const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
          applyTheme(next);
          return { theme: next };
        }),
      selectedLocation: "harare",
      setSelectedLocation: (slug) => set({ selectedLocation: slug }),
      selectedActivities: [],
      toggleActivity: (id) =>
        set((state) => ({
          selectedActivities: state.selectedActivities.includes(id)
            ? state.selectedActivities.filter((a) => a !== id)
            : [...state.selectedActivities, id],
        })),
    }),
    {
      name: "mukoko-weather-prefs",
      storage: createJSONStorage(() => safeLocalStorage),
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.theme);
      },
    },
  ),
);
