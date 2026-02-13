"use client";

import { useEffect } from "react";
import { useAppStore, resolveTheme } from "@/lib/store";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useAppStore((s) => s.theme);

  // Apply resolved theme to DOM whenever preference changes
  useEffect(() => {
    try {
      document.documentElement.setAttribute("data-theme", resolveTheme(theme));
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
          document.documentElement.setAttribute("data-theme", mq.matches ? "dark" : "light");
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
