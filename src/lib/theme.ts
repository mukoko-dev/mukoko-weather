/**
 * Theme preference helpers with no dependencies, so the embed widget and the
 * map can resolve the theme without pulling in the Zustand/RxDB store.
 */

export type ThemePreference = "light" | "dark" | "system";

/** Resolve the effective theme (light/dark) for a given preference */
export function resolveTheme(pref: ThemePreference): "light" | "dark" {
  if (pref !== "system") return pref;
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}
