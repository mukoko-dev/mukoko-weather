"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { highLowLabel, tempLabel, type CardSummary } from "@/lib/location-card";

export interface LocationCardMenuItem {
  label: string;
  onSelect: () => void;
  tone?: "default" | "danger";
}

export interface LocationWeatherCardProps {
  /** `/` for the current location, `/{slug}` for saved places. */
  href: string;
  /** Place name shown large at the top-left. */
  name: string;
  /** Second line: "My Location" for the current place, else the local time. */
  subtitle: string;
  /** Whether this place is the visitor's Home location. */
  isHome?: boolean;
  /** Loading shows a same-size skeleton; error keeps the name visible. */
  status: "loading" | "ready" | "error";
  /** Loaded display model (status === "ready"). */
  summary?: CardSummary | null;
  /** Full accessible name, e.g. "Harare, 25°, Overcast, high 27 low 17". */
  accessibleName: string;
  /** Optional "⋯" menu actions. Omit to hide the menu button. */
  menu?: LocationCardMenuItem[];
}

/**
 * One place in the Locations list, styled like iOS Weather: a large rounded
 * card painted with its condition sky, name and time at the left, temperature
 * at the right, condition and high/low along the bottom.
 *
 * The whole card is one link. The optional "⋯" menu is a sibling of the link
 * (never nested inside it, which would be invalid interactive markup).
 */
export function LocationWeatherCard({
  href,
  name,
  subtitle,
  isHome = false,
  status,
  summary = null,
  accessibleName,
  menu,
}: LocationWeatherCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close the menu on outside pointer-down or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const menuButton =
    menu && menu.length > 0 ? (
      <div ref={wrapRef} className="absolute right-2 top-2 z-10">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuId}
          aria-label={`More options for ${name}`}
          onClick={() => setMenuOpen((open) => !open)}
          className="press-scale flex h-[var(--touch-target-min)] w-[var(--touch-target-min)] items-center justify-center rounded-full text-xl leading-none text-[var(--color-oryx-fg)]"
        >
          <span aria-hidden="true">⋯</span>
        </button>
        {menuOpen && (
          <ul
            id={menuId}
            role="menu"
            aria-label={`Options for ${name}`}
            className="absolute right-0 top-full z-20 mt-1 min-w-52 rounded-card border border-border bg-surface-card p-1 text-left text-sm shadow-lg"
          >
            {menu!.map((item) => (
              <li key={item.label} role="none">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    item.onSelect();
                  }}
                  className={`press-scale flex w-full items-center rounded-button px-3 py-3 min-h-[var(--touch-target-min)] hover:bg-surface-dim ${
                    item.tone === "danger"
                      ? "text-severity-severe"
                      : "text-text-primary"
                  }`}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    ) : null;

  if (status === "loading") {
    return (
      <div className="relative">
        <div
          role="status"
          aria-label="Loading"
          aria-busy="true"
          className="chameleon min-h-40 p-5"
        >
          <span className="sr-only">Loading {name} weather</span>
          <p className="text-xl font-semibold text-text-primary">{name}</p>
          <p className="mt-2 h-4 w-24 animate-pulse rounded-badge bg-surface-dim" />
          <p className="mt-10 h-4 w-40 animate-pulse rounded-badge bg-surface-dim" />
        </div>
      </div>
    );
  }

  if (status === "error" || !summary) {
    return (
      <div className="relative">
        <Link
          href={href}
          aria-label={accessibleName}
          className="acacia block min-h-40 p-5 text-text-primary"
        >
          <p className="pr-12 text-xl font-semibold">{name}</p>
          <p className="mt-1 text-sm text-text-secondary">{subtitle}</p>
          <p className="mt-10 text-base text-text-secondary">
            Weather unavailable
          </p>
        </Link>
        {menuButton}
      </div>
    );
  }

  return (
    <div className="relative">
      <Link
        href={href}
        aria-label={accessibleName}
        className={`oryx ${summary.sky} block min-h-40 p-5 pb-4`}
      >
        <div className="flex items-start justify-between gap-3 pr-12">
          <div className="min-w-0">
            <p className="truncate text-xl font-semibold">{name}</p>
            <p className="text-sm">
              {subtitle}
              {isHome && (
                <>
                  {" · "}
                  <span aria-hidden="true">⌂</span> Home
                </>
              )}
            </p>
          </div>
        </div>
        <div className="mt-2 flex items-end justify-between gap-3">
          <p className="text-base">{summary.condition}</p>
          <p className="text-6xl font-thin leading-none tabular-nums">
            {tempLabel(summary.temperature)}
          </p>
        </div>
        <p className="mt-2 text-right text-sm tabular-nums">
          {highLowLabel(summary.high, summary.low)}
        </p>
      </Link>
      {menuButton}
    </div>
  );
}
