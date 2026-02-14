"use client";

import { useAppStore, type ThemePreference } from "@/lib/store";
import { SunIcon, MoonIcon } from "@/lib/weather-icons";
import { Button } from "@/components/ui/button";

function MonitorIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <line x1="8" x2="16" y1="21" y2="21" />
      <line x1="12" x2="12" y1="17" y2="21" />
    </svg>
  );
}

const LABELS: Record<ThemePreference, string> = {
  light: "Light mode — switch to dark",
  dark: "Dark mode — switch to system",
  system: "System theme — switch to light",
};

export function ThemeToggle() {
  const { theme, toggleTheme } = useAppStore();

  return (
    <Button
      variant="outline"
      size="icon-lg"
      onClick={toggleTheme}
      aria-label={LABELS[theme]}
    >
      {theme === "light" && <MoonIcon size={20} />}
      {theme === "dark" && <MonitorIcon size={20} />}
      {theme === "system" && <SunIcon size={20} />}
    </Button>
  );
}
