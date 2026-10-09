"use client";

import { Button } from "@/components/ui/button";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { useAppStore } from "@/lib/store";

interface LocationsMenuProps {
  editing: boolean;
  onToggleEditing: () => void;
}

/**
 * The "⋯" menu in the Locations header: Edit list, Units, and links to
 * Explore, History and Aviation. Units has no switch of its own yet, so it
 * opens the My Weather Settings tab, where preferences live.
 */
export function LocationsMenu({
  editing,
  onToggleEditing,
}: LocationsMenuProps) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const openMyWeather = useAppStore((s) => s.openMyWeather);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const itemClass =
    "press-scale flex w-full items-center rounded-button px-3 py-3 min-h-[var(--touch-target-min)] text-left text-text-primary hover:bg-surface-dim";

  return (
    <div ref={wrapRef} className="relative">
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label="More: edit list, units, Explore, History, Aviation"
        onClick={() => setOpen((v) => !v)}
        className="press-scale bg-surface-card"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </Button>
      {open && (
        <ul
          id={menuId}
          role="menu"
          aria-label="Weather menu"
          className="absolute right-0 top-full z-30 mt-2 w-56 rounded-card border border-border bg-surface-card p-1 text-sm shadow-lg"
        >
          <li role="none">
            <button
              type="button"
              role="menuitem"
              className={itemClass}
              onClick={() => {
                setOpen(false);
                onToggleEditing();
              }}
            >
              {editing ? "Done editing" : "Edit list"}
            </button>
          </li>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              className={itemClass}
              onClick={() => {
                setOpen(false);
                openMyWeather("settings");
              }}
            >
              Units
            </button>
          </li>
          <li role="none">
            <Link
              href="/explore"
              role="menuitem"
              prefetch={false}
              className={itemClass}
              onClick={() => setOpen(false)}
            >
              Explore
            </Link>
          </li>
          <li role="none">
            <Link
              href="/history"
              role="menuitem"
              prefetch={false}
              className={itemClass}
              onClick={() => setOpen(false)}
            >
              History
            </Link>
          </li>
          <li role="none">
            <Link
              href="/aviation"
              role="menuitem"
              prefetch={false}
              className={itemClass}
              onClick={() => setOpen(false)}
            >
              Aviation
            </Link>
          </li>
        </ul>
      )}
    </div>
  );
}
