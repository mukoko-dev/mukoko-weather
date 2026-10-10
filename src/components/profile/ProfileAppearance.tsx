"use client";

/**
 * Appearance — the theme choice, shown as three exclusive options (Mukoko
 * ecosystem profile standard: mukoko-news
 * `src/components/profile/profile-appearance.tsx`). Every option is visible
 * at once rather than hidden behind a cycle button, and each is a `radio` in
 * a named group so a screen reader announces "2 of 3".
 *
 * Reads and writes the same Zustand theme the My Weather modal's Settings tab
 * uses, so the two controls can never disagree. Contrast follows the device
 * (`prefers-contrast: more` in globals.css) — weather has no separate
 * contrast preference to offer here.
 */

import { Check, Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { ThemePreference } from "@/lib/theme";

export const THEME_OPTIONS: {
  value: ThemePreference;
  label: string;
  hint: string;
  icon: LucideIcon;
}[] = [
  { value: "light", label: "Light", hint: "Always light", icon: Sun },
  { value: "dark", label: "Dark", hint: "Always dark", icon: Moon },
  {
    value: "system",
    label: "System",
    hint: "Follows your device",
    icon: Monitor,
  },
];

export function ProfileAppearance() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);

  return (
    <section aria-labelledby="profile-appearance" className="guineafowl">
      <h2 id="profile-appearance" className="guineafowl-heading">
        Appearance
      </h2>
      <fieldset className="px-4 py-4">
        <legend className="mb-3 text-sm font-medium text-text-primary">
          Theme
        </legend>
        <div
          role="radiogroup"
          aria-label="Theme"
          className="grid grid-cols-3 gap-3"
        >
          {THEME_OPTIONS.map((t) => {
            const selected = theme === t.value;
            const Icon = t.icon;
            return (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setTheme(t.value)}
                className={cn(
                  "flex min-h-[var(--touch-target-min)] flex-col items-center gap-2 rounded-[var(--radius-input)] border-2 p-3 text-center transition-colors",
                  selected
                    ? "border-primary bg-surface-dim"
                    : "border-border hover:bg-surface-dim",
                )}
              >
                <Icon
                  className="h-5 w-5 text-text-secondary"
                  aria-hidden="true"
                />
                <span className="flex items-center gap-1">
                  <Check
                    className={cn(
                      "h-3.5 w-3.5 shrink-0 text-primary",
                      !selected && "invisible",
                    )}
                    aria-hidden="true"
                  />
                  <span className="text-sm font-medium text-text-primary">
                    {t.label}
                  </span>
                </span>
                <span className="dove text-xs">{t.hint}</span>
              </button>
            );
          })}
        </div>
      </fieldset>
    </section>
  );
}
