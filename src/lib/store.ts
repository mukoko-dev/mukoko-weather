import { create } from "zustand";
import { persist } from "zustand/middleware";

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
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.theme);
      },
    },
  ),
);
