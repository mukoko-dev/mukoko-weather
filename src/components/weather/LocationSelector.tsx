"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { MapPinIcon } from "@/lib/weather-icons";
import {
  LOCATIONS,
  searchLocations,
  getLocationsByTag,
  TAG_LABELS,
  type LocationTag,
  type ZimbabweLocation,
} from "@/lib/locations";
import { detectUserLocation, type GeoResult } from "@/lib/geolocation";

const POPULAR_SLUGS = [
  "harare", "bulawayo", "mutare", "gweru", "masvingo",
  "victoria-falls", "kariba", "marondera", "chinhoyi", "kwekwe",
];

const TAG_ORDER: LocationTag[] = [
  "city", "farming", "mining", "tourism", "national-park", "education", "border", "travel",
];

export function LocationSelector({ currentSlug }: { currentSlug: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<LocationTag | null>(null);
  const [geoState, setGeoState] = useState<GeoResult | null>(null);
  const [geoLoading, setGeoLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const current = LOCATIONS.find((l) => l.slug === currentSlug);

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
        setActiveTag(null);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Close on Escape key — WCAG 2.1.1 keyboard accessible
  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape" && open) {
        setOpen(false);
        setQuery("");
        setActiveTag(null);
      }
    }
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [open]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Geolocation detection
  const handleGeolocate = useCallback(async () => {
    setGeoLoading(true);
    const result = await detectUserLocation();
    setGeoState(result);
    setGeoLoading(false);

    if (result.status === "success" && result.location) {
      setOpen(false);
      router.push(`/${result.location.slug}`);
    }
  }, [router]);

  // Filtered locations
  const displayedLocations = useMemo((): ZimbabweLocation[] => {
    if (query.length > 0) {
      return searchLocations(query);
    }
    if (activeTag) {
      return getLocationsByTag(activeTag);
    }
    // Default: show popular cities
    return LOCATIONS.filter((l) => POPULAR_SLUGS.includes(l.slug));
  }, [query, activeTag]);

  const handleSelect = (slug: string) => {
    setOpen(false);
    router.push(`/${slug}`);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (!next) {
            setQuery("");
            setActiveTag(null);
          }
        }}
        className="flex min-h-[44px] items-center gap-2 rounded-[var(--radius-button)] bg-surface-card px-4 py-2 text-sm font-medium text-text-primary shadow-sm transition-colors hover:bg-surface-elevated focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`Select location. Currently: ${current?.name ?? "Harare"}`}
        type="button"
      >
        <MapPinIcon size={16} className="text-primary" />
        <span className="max-w-[120px] truncate sm:max-w-none">{current?.name ?? "Harare"}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" className="text-text-tertiary" aria-hidden="true">
          <path d="M3 5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-[var(--radius-card)] bg-surface-card shadow-lg sm:w-96">
          {/* Search input */}
          <div className="border-b border-text-tertiary/10 p-3">
            <div className="relative">
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveTag(null);
                }}
                placeholder="Search locations..."
                className="w-full rounded-[var(--radius-input)] bg-surface-base px-3 py-2 pl-9 text-sm text-text-primary placeholder-text-tertiary outline-none focus-visible:ring-2 focus-visible:ring-primary"
                aria-label="Search locations"
              />
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
                width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
            </div>
          </div>

          {/* Geolocation button */}
          <div className="border-b border-text-tertiary/10 px-3 py-2">
            <button
              onClick={handleGeolocate}
              disabled={geoLoading}
              className="flex min-h-[44px] w-full items-center gap-3 rounded-[var(--radius-input)] px-3 py-2 text-sm text-primary transition-colors hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
              type="button"
            >
              {geoLoading ? (
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M12 2v4" /><path d="M12 18v4" />
                  <path d="M2 12h4" /><path d="M18 12h4" />
                </svg>
              )}
              <span className="font-medium">
                {geoLoading ? "Detecting location..." : "Use my location"}
              </span>
            </button>
            {geoState?.status === "denied" && (
              <p className="px-3 pb-1 text-xs text-text-tertiary">
                Location access denied. Enable it in your browser settings.
              </p>
            )}
            {geoState?.status === "outside-zw" && (
              <p className="px-3 pb-1 text-xs text-text-tertiary">
                You appear to be outside Zimbabwe. Select a location below.
              </p>
            )}
          </div>

          {/* Tag filter pills */}
          {!query && (
            <div role="group" aria-label="Filter locations by category" className="flex flex-wrap gap-1.5 border-b border-text-tertiary/10 px-3 py-2">
              {TAG_ORDER.map((tag) => (
                <button
                  key={tag}
                  onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                  aria-pressed={activeTag === tag}
                  className={`rounded-[var(--radius-badge)] px-2.5 py-1 text-xs font-medium transition-colors ${
                    activeTag === tag
                      ? "bg-primary text-primary-foreground"
                      : "bg-surface-base text-text-secondary hover:text-text-primary"
                  }`}
                  type="button"
                >
                  {TAG_LABELS[tag]}
                </button>
              ))}
            </div>
          )}

          {/* Location list */}
          <ul
            role="listbox"
            aria-label="Available locations"
            className="max-h-64 overflow-y-auto p-2"
          >
            {displayedLocations.length === 0 && (
              <li className="px-3 py-4 text-center text-sm text-text-tertiary">
                No locations found for &quot;{query}&quot;
              </li>
            )}
            {displayedLocations.map((loc) => (
              <li key={loc.slug} role="option" aria-selected={loc.slug === currentSlug}>
                <button
                  onClick={() => handleSelect(loc.slug)}
                  className={`flex w-full min-h-[44px] items-center gap-3 rounded-[var(--radius-input)] px-3 py-2 text-sm transition-colors hover:bg-surface-base focus-visible:outline-2 focus-visible:outline-primary ${
                    loc.slug === currentSlug
                      ? "bg-primary/10 text-primary font-semibold"
                      : "text-text-primary"
                  }`}
                  type="button"
                >
                  <MapPinIcon
                    size={14}
                    className={loc.slug === currentSlug ? "text-primary" : "text-text-tertiary"}
                  />
                  <div className="flex flex-col items-start">
                    <span>{loc.name}</span>
                    <span className="text-xs text-text-tertiary">
                      {loc.province}
                    </span>
                  </div>
                  <div className="ml-auto flex gap-1">
                    {loc.tags.slice(0, 2).map((tag) => (
                      <span
                        key={tag}
                        className="rounded-[var(--radius-badge)] bg-surface-base px-1.5 py-0.5 text-[10px] text-text-tertiary"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </button>
              </li>
            ))}
          </ul>

          {/* Total count footer */}
          <div className="border-t border-text-tertiary/10 px-3 py-2">
            <p className="text-xs text-text-tertiary">
              {LOCATIONS.length} locations across Zimbabwe
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
