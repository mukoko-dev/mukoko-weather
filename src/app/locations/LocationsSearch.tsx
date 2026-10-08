"use client";

import { useId } from "react";
import { useLocationQuickSearch } from "@/lib/use-location-quick-search";
import { isLocationSlug } from "@/lib/current-slug";
import { MAX_SAVED_LOCATIONS, useAppStore } from "@/lib/store";
import { SearchIcon } from "@/lib/weather-icons";

interface LocationsSearchProps {
  /** Slugs already listed (My Location, saved, suggested): never offered again. */
  listed: readonly string[];
}

/**
 * The search bar pinned to the bottom of the Locations list. Picking a result
 * saves it. Uses the shared quick-search hook, so it behaves like every other
 * location search in the app.
 */
export function LocationsSearch({ listed }: LocationsSearchProps) {
  const inputId = useId();
  const { query, setQuery, results, loading, error, reset } =
    useLocationQuickSearch({ limit: 8 });
  const saveLocation = useAppStore((s) => s.saveLocation);
  const rememberLocationName = useAppStore((s) => s.rememberLocationName);
  const savedCount = useAppStore((s) => s.savedLocations.length);

  const listedSet = new Set(listed);
  const offered = results.filter(
    (r) => isLocationSlug(r.slug) && !listedSet.has(r.slug),
  );
  const atCap = savedCount >= MAX_SAVED_LOCATIONS;
  const hasQuery = query.trim().length > 0;

  const choose = (slug: string, name: string) => {
    rememberLocationName(slug, name);
    saveLocation(slug);
    reset();
  };

  return (
    <div className="relative">
      {hasQuery && (
        <div className="absolute bottom-full left-0 right-0 mb-2 max-h-72 overflow-y-auto rounded-card border border-border bg-surface-card p-1 shadow-lg">
          {loading && (
            <p role="status" aria-label="Loading" className="px-3 py-3 text-sm text-text-secondary">
              Searching…
            </p>
          )}
          {!loading && error && (
            <p className="px-3 py-3 text-sm text-text-secondary">
              Search is unavailable right now.
            </p>
          )}
          {!loading && !error && offered.length === 0 && (
            <p className="px-3 py-3 text-sm text-text-secondary">
              No matching places.
            </p>
          )}
          {!loading && offered.length > 0 && (
            <ul aria-label="Search results" className="flex flex-col">
              {offered.map((r) => (
                <li key={r.slug}>
                  <button
                    type="button"
                    disabled={atCap}
                    onClick={() => choose(r.slug, r.name)}
                    className="press-scale flex w-full flex-col items-start rounded-button px-3 py-2 min-h-[var(--touch-target-min)] text-left text-text-primary hover:bg-surface-dim disabled:opacity-50"
                  >
                    <span className="font-semibold">{r.name}</span>
                    {(r.province || r.country) && (
                      <span className="text-sm text-text-secondary">
                        {[r.province, r.country].filter(Boolean).join(", ")}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {atCap && (
        <p className="mb-2 text-center text-sm text-text-secondary">
          You can save up to {MAX_SAVED_LOCATIONS} places. Remove one to add
          another.
        </p>
      )}
      <div className="flex h-[var(--touch-target-min)] items-center gap-3 rounded-full border border-border bg-surface-card px-4 shadow-md">
        <label htmlFor={inputId} className="sr-only">
          Search for a city or airport
        </label>
        <SearchIcon className="shrink-0 text-text-secondary" size={18} />
        <input
          id={inputId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search for a city or airport"
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-base text-text-primary outline-none placeholder:text-text-secondary"
        />
      </div>
    </div>
  );
}
