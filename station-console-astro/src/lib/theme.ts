export type ThemePreference = "system" | "light" | "dark";

export const THEME_KEY = "mws-theme";

export function parseThemePreference(value: string | null | undefined): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export function resolveDark(pref: ThemePreference, systemDark: boolean): boolean {
  return pref === "dark" || (pref === "system" && systemDark);
}
