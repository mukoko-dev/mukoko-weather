"use client";

import { useEffect, useState } from "react";
import { useAppStore } from "@/lib/store";

/**
 * Resolves the current Mapbox style based on the user's theme preference.
 * Subscribes to OS `prefers-color-scheme` changes when theme is `"system"`.
 */
export function useMapStyle(): string {
  const theme = useAppStore((s) => s.theme);
  const [osDark, setOsDark] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setOsDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  const isDark = theme === "dark" || (theme === "system" && osDark);
  return isDark ? "dark-v11" : "streets-v12";
}
