"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { MapPinIcon } from "@/lib/weather-icons";
import { LOCATIONS } from "@/lib/locations";

export function LocationSelector({ currentSlug }: { currentSlug: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const current = LOCATIONS.find((l) => l.slug === currentSlug);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex min-h-[44px] items-center gap-2 rounded-[var(--radius-button)] bg-surface-card px-4 py-2 text-sm font-medium text-text-primary shadow-sm transition-colors hover:bg-surface-elevated focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`Select location. Currently: ${current?.name ?? "Harare"}`}
        type="button"
      >
        <MapPinIcon size={16} className="text-primary" />
        <span>{current?.name ?? "Harare"}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" className="text-text-tertiary" aria-hidden="true">
          <path d="M3 5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <ul
          role="listbox"
          aria-label="Available locations"
          className="absolute left-0 top-full z-40 mt-2 max-h-72 w-64 overflow-y-auto rounded-[var(--radius-card)] bg-surface-card p-2 shadow-lg"
        >
          {LOCATIONS.map((loc) => (
            <li key={loc.slug} role="option" aria-selected={loc.slug === currentSlug}>
              <button
                onClick={() => {
                  setOpen(false);
                  router.push(`/${loc.slug}`);
                }}
                className={`flex w-full min-h-[44px] items-center gap-3 rounded-[var(--radius-input)] px-3 py-2 text-sm transition-colors hover:bg-surface-base focus-visible:outline-2 focus-visible:outline-primary ${
                  loc.slug === currentSlug ? "bg-primary/10 text-primary font-semibold" : "text-text-primary"
                }`}
                type="button"
              >
                <MapPinIcon size={14} className={loc.slug === currentSlug ? "text-primary" : "text-text-tertiary"} />
                <span>{loc.name}</span>
                <span className="ml-auto text-xs text-text-tertiary">{loc.province}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
