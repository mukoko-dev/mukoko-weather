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

import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
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

/**
 * A miniature of the app on a plain surface, drawn in the token set of the
 * theme it stands for: `data-theme` on the wrapper re-points every colour
 * token inside it, so the Light preview stays light on a dark device. System
 * is the two halves split on the diagonal.
 */
function Mini({ theme }: { theme: "light" | "dark" }) {
  return (
    <span
      data-theme={theme}
      className="absolute inset-0 block bg-background"
      aria-hidden="true"
    >
      <span className="absolute left-[12%] top-[22%] block h-[6%] w-[38%] rounded-full bg-text-secondary" />
      <span className="absolute left-[12%] top-[36%] block h-[6%] w-[26%] rounded-full bg-text-tertiary" />
      <span className="absolute bottom-[16%] right-[12%] block h-[16%] w-[10%] rounded-full bg-primary" />
    </span>
  );
}

function ThemePreview({ value }: { value: ThemePreference }) {
  return (
    <span className="relative block aspect-[4/3] w-full overflow-hidden rounded-[var(--radius-card)] border border-border">
      {value === "system" ? (
        <>
          <Mini theme="dark" />
          <span className="absolute inset-0 block [clip-path:polygon(0_0,100%_0,0_100%)]">
            <Mini theme="light" />
          </span>
        </>
      ) : (
        <Mini theme={value} />
      )}
    </span>
  );
}

export function ProfileAppearance() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);

  return (
    <section aria-labelledby="profile-appearance" className="guineafowl">
      <h2 id="profile-appearance" className="guineafowl-heading">
        Appearance
      </h2>
      <div className="guineafowl-card p-3">
        <div
          role="radiogroup"
          aria-label="Theme"
          className="grid grid-cols-3 gap-3"
        >
          {THEME_OPTIONS.map((t) => {
            const selected = theme === t.value;
            return (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={`${t.label}: ${t.hint}`}
                onClick={() => setTheme(t.value)}
                className="flex min-h-[var(--touch-target-min)] flex-col items-stretch gap-2 text-center"
              >
                <span
                  className={cn(
                    "block rounded-[var(--radius-card)] p-0.5 transition-colors",
                    selected
                      ? "ring-2 ring-primary"
                      : "ring-1 ring-transparent hover:ring-border",
                  )}
                >
                  <ThemePreview value={t.value} />
                </span>
                <span
                  className={cn(
                    "text-sm font-medium",
                    selected ? "text-primary" : "text-text-secondary",
                  )}
                >
                  {t.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
