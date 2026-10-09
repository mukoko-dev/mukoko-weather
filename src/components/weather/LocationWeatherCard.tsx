"use client";

import { Button } from "@/components/ui/button";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import {
  highLowLabel,
  plateClassesFor,
  tempLabel,
  type CardSummary,
} from "@/lib/location-card";

export interface LocationCardMenuItem {
  label: string;
  onSelect: () => void;
  tone?: "default" | "danger";
}

export interface LocationWeatherCardProps {
  /** `/` for the current location, `/{slug}` for other places. */
  href: string;
  /** Place name shown large at the top-left. */
  name: string;
  /** Mono label line: "My location · 17:03", "Saved · 17:03", "Suggested · 17:03". */
  label: string;
  /** Whether this place is the visitor's Home location (⌂ glyph). */
  isHome?: boolean;
  /** Loading shows a same-size skeleton; error keeps the name visible. */
  status: "loading" | "ready" | "error";
  /** Loaded display model (status === "ready"). */
  summary?: CardSummary | null;
  /** Full accessible name, e.g. "Harare, 25°, Overcast, high 27 low 17". */
  accessibleName: string;
  /** Optional "⋯" menu actions. Omit to hide the menu button. */
  menu?: LocationCardMenuItem[];
  /** Edit mode: shows a remove control on the leading edge instead of navigating. */
  editing?: boolean;
  /** Accessible name for the remove control, e.g. "Remove Harare from your places". */
  removeLabel?: string;
  onRemove?: () => void;
}

/**
 * One place in the Locations list, styled as a weather card: a tall rounded
 * tile on a mineral-tinted plate with a 4px mineral edge on the leading side.
 * One number (the temperature, in Noto Serif), one mono label, one sentence
 * of meaning (the condition with its high and low).
 *
 * The whole card is one link. The optional "⋯" menu and the edit-mode remove
 * control are siblings of the link, never nested inside it.
 */
export function LocationWeatherCard({
  href,
  name,
  label,
  isHome = false,
  status,
  summary = null,
  accessibleName,
  menu,
  editing = false,
  removeLabel,
  onRemove,
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
    !editing && menu && menu.length > 0 ? (
      <div ref={wrapRef} className="absolute right-2 top-2 z-10">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuId}
          aria-label={`More options for ${name}`}
          onClick={() => setMenuOpen((open) => !open)}
          className="press-scale text-xl leading-none"
        >
          <span aria-hidden="true">⋯</span>
        </Button>
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

  const removeButton =
    editing && onRemove ? (
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeLabel ?? `Remove ${name}`}
        className="press-scale absolute left-5 top-1/2 z-10 flex h-[var(--touch-target-min)] w-[var(--touch-target-min)] -translate-y-1/2 items-center justify-center rounded-full bg-severity-severe text-xl leading-none text-severity-fg"
      >
        <span aria-hidden="true">−</span>
      </button>
    ) : null;

  // Leading padding leaves room for the edit-mode remove control.
  const leadPad = editing && onRemove ? "pl-20" : "";

  if (status === "loading") {
    return (
      <div className="relative">
        <div
          role="status"
          aria-label="Loading"
          aria-busy="true"
          className={`chameleon min-h-44 border-l-4 p-5 ${leadPad}`}
        >
          <span className="sr-only">Loading {name} weather</span>
          <p className="text-xl font-semibold text-text-primary">{name}</p>
          <p className="mt-2 h-4 w-24 animate-pulse rounded-badge bg-surface-dim" />
          <p className="mt-10 h-12 w-24 animate-pulse rounded-badge bg-surface-dim" />
          <p className="mt-3 h-4 w-40 animate-pulse rounded-badge bg-surface-dim" />
        </div>
      </div>
    );
  }

  if (status === "error" || !summary) {
    return (
      <div className="relative">
        {editing && onRemove ? (
          <div
            role="group"
            aria-label={accessibleName}
            className={`acacia block min-h-44 border-l-4 border-l-border p-5 text-text-primary ${leadPad}`}
          >
            {removeButton}
            <p className="pr-12 text-xl font-semibold">{name}</p>
            <p className="mt-1 font-mono text-xs uppercase tracking-wide text-text-secondary">
              {label}
            </p>
            <p className="mt-10 text-base text-text-secondary">
              Weather unavailable
            </p>
          </div>
        ) : (
          <Link
            href={href}
            aria-label={accessibleName}
            className="acacia block min-h-44 border-l-4 border-l-border p-5 text-text-primary"
          >
            <p className="pr-12 text-xl font-semibold">{name}</p>
            <p className="mt-1 font-mono text-xs uppercase tracking-wide text-text-secondary">
              {label}
            </p>
            <p className="mt-10 text-base text-text-secondary">
              Weather unavailable
            </p>
          </Link>
        )}
        {menuButton}
      </div>
    );
  }

  const plate = plateClassesFor(summary.sky, summary.isDay);
  const tileClass = `block min-h-44 rounded-card border border-border border-l-4 p-5 pb-4 text-text-primary ${plate.plate} ${plate.edge} ${leadPad}`;

  const body = (
    <>
      <div className="flex items-start justify-between gap-3 pr-12">
        <div className="min-w-0">
          <p className="truncate text-xl font-semibold">{name}</p>
          <p className="font-mono text-xs uppercase tracking-wide text-text-secondary">
            {label}
            {isHome && (
              <>
                {" · "}
                <span aria-hidden="true">⌂</span> Home
              </>
            )}
          </p>
        </div>
      </div>
      <p className="mt-3 font-display text-6xl leading-none tabular-nums">
        {tempLabel(summary.temperature)}
      </p>
      <div className="mt-3 flex items-end justify-between gap-3">
        <p className="text-base">{summary.condition}</p>
        <p className="text-sm tabular-nums text-text-secondary">
          {highLowLabel(summary.high, summary.low)}
        </p>
      </div>
    </>
  );

  if (editing && onRemove) {
    return (
      <div className="relative">
        <div role="group" aria-label={accessibleName} className={tileClass}>
          {removeButton}
          {body}
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      <Link href={href} aria-label={accessibleName} className={tileClass}>
        {body}
      </Link>
      {menuButton}
    </div>
  );
}
