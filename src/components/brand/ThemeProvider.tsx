"use client";

import { useEffect } from "react";
import { useAppStore, resolveTheme, initializeDeviceSync } from "@/lib/store";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useAppStore((s) => s.theme);

  // Initialize device sync once on mount (after Zustand rehydrates).
  // Safe against React Strict Mode double-mount: initDeviceSync() in
  // device-sync.ts uses a module-level `initPromise` guard that persists
  // across remounts, so calling it twice is a no-op.
  useEffect(() => {
    initializeDeviceSync();
  }, []);

  // Apply resolved theme to DOM whenever preference changes. Read from the
  // store, not from this render's `theme`: the effect above has just adopted
  // the choice this device recorded (initializeDeviceSync, src/lib/theme.ts)
  // and this render still holds the default, which would flip a person who
  // chose dark on a light phone back to light until the preferences load.
  useEffect(() => {
    try {
      document.documentElement.setAttribute(
        "data-theme",
        resolveTheme(useAppStore.getState().theme),
      );
      document.documentElement.setAttribute("data-brand", "mukoko-weather");
    } catch {
      // DOM attribute access failed (shouldn't happen, but be safe)
    }
  }, [theme]);

  // Listen for OS theme changes when in "system" mode
  useEffect(() => {
    if (theme !== "system") return;

    try {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => {
        try {
          document.documentElement.setAttribute(
            "data-theme",
            mq.matches ? "dark" : "light",
          );
        } catch {
          // Silently fail
        }
      };

      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    } catch {
      // matchMedia not available
    }
  }, [theme]);

  return <>{children}</>;
}
