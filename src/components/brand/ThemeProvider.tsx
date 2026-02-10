"use client";

import { useEffect } from "react";
import { useAppStore, resolveTheme } from "@/lib/store";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useAppStore((s) => s.theme);

  // Apply resolved theme to DOM whenever preference changes
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolveTheme(theme));
    document.documentElement.setAttribute("data-brand", "mukoko-weather");
  }, [theme]);

  // Listen for OS theme changes when in "system" mode
  useEffect(() => {
    if (theme !== "system") return;

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      document.documentElement.setAttribute("data-theme", mq.matches ? "dark" : "light");
    };

    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  return <>{children}</>;
}
