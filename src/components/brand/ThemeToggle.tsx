"use client";

import { useAppStore } from "@/lib/store";
import { SunIcon, MoonIcon } from "@/lib/weather-icons";

export function ThemeToggle() {
  const { theme, toggleTheme } = useAppStore();

  return (
    <button
      onClick={toggleTheme}
      className="flex h-11 w-11 items-center justify-center rounded-[var(--radius-button)] border border-text-tertiary/20 bg-surface-card text-text-primary transition-colors hover:bg-surface-elevated focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
      type="button"
    >
      {theme === "light" ? <MoonIcon size={20} /> : <SunIcon size={20} />}
    </button>
  );
}
