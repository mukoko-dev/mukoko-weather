import { create } from "zustand";
import { persist } from "zustand/middleware";

interface AppState {
  theme: "light" | "dark";
  toggleTheme: () => void;
  selectedLocation: string; // slug
  setSelectedLocation: (slug: string) => void;
  selectedActivities: string[]; // activity IDs from src/lib/activities.ts
  toggleActivity: (id: string) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      theme: "light",
      toggleTheme: () =>
        set((state) => {
          const next = state.theme === "light" ? "dark" : "light";
          if (typeof document !== "undefined") {
            document.documentElement.setAttribute("data-theme", next);
            document.documentElement.setAttribute("data-brand", "mukoko");
          }
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
        if (state && typeof document !== "undefined") {
          document.documentElement.setAttribute("data-theme", state.theme);
          document.documentElement.setAttribute("data-brand", "mukoko");
        }
      },
    },
  ),
);
