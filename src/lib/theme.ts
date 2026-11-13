/**
 * Theme preference helpers with no dependencies, so the embed widget and the
 * map can resolve the theme without pulling in the Zustand/RxDB store.
 */

import { readStorage, removeStorage, writeStorage } from "./safe-storage";

export type ThemePreference = "light" | "dark" | "system";

/** Resolve the effective theme (light/dark) for a given preference */
export function resolveTheme(pref: ThemePreference): "light" | "dark" {
  if (pref !== "system") return pref;
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/**
 * The device's own record of an explicit theme choice, in localStorage, so the
 * page can settle its theme BEFORE first paint: the script in the root layout
 * reads it (`THEME_INIT_SCRIPT`). The preferences live in IndexedDB (RxDB),
 * which cannot be read that early, and the old `mukoko-weather-prefs` key is
 * removed once they have moved there; without this key a person who chose dark
 * on a phone set to light saw a pale page that flipped to dark about a second
 * later. Only "light" or "dark" is kept: "system" is the absence of the key.
 * The store writes it whenever the theme is applied (`applyTheme`), so the
 * preferences, this key and the page cannot disagree.
 */
export const THEME_STORAGE_KEY = "mukoko-theme";

/** The explicit theme this device recorded, or null (follow the system). */
export function readStoredTheme(): "light" | "dark" | null {
  const value = readStorage(THEME_STORAGE_KEY);
  return value === "light" || value === "dark" ? value : null;
}

/** Record a theme preference for the next first paint. Never throws. */
export function rememberTheme(pref: ThemePreference): void {
  if (pref === "light" || pref === "dark") {
    writeStorage(THEME_STORAGE_KEY, pref);
  } else {
    removeStorage(THEME_STORAGE_KEY);
  }
}

/**
 * The inline script in the document `<head>` that sets `data-theme` before the
 * first paint. In order: this device's recorded choice, the old Zustand key
 * (a device where IndexedDB was unavailable still keeps its preferences
 * there), then the system's setting; light if nothing can be read. Plain ES5
 * and no imports, because it is a string the server sends. The Astro shell
 * (`astro/src/layouts/Shell.astro`) carries the same rule; a test keeps the
 * two keys equal.
 */
export const THEME_INIT_SCRIPT =
  "(function(){var d=document.documentElement;" +
  `try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});` +
  'if(t==="light"||t==="dark"){d.setAttribute("data-theme",t);return}}catch(e){}' +
  'try{var s=JSON.parse(localStorage.getItem("mukoko-weather-prefs")||"{}");' +
  "var p=s&&s.state&&s.state.theme;" +
  'if(p==="light"||p==="dark"){d.setAttribute("data-theme",p);return}}catch(e){}' +
  'try{d.setAttribute("data-theme",matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light")}' +
  'catch(e){d.setAttribute("data-theme","light")}})();';
