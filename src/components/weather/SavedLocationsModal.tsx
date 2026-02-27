"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAppStore, MAX_SAVED_LOCATIONS } from "@/lib/store";
import { useDebounce } from "@/lib/use-debounce";
import { MapPinIcon, SearchIcon, TrashIcon, PlusIcon, NavigationIcon } from "@/lib/weather-icons";
import type { WeatherLocation } from "@/lib/locations";
import { detectUserLocation, type GeoResult } from "@/lib/geolocation";
import { Dialog, DialogContent, DialogSheetHandle, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trackEvent } from "@/lib/analytics";

export function SavedLocationsModal() {
  const savedLocationsOpen = useAppStore((s) => s.savedLocationsOpen);
  const closeSavedLocations = useAppStore((s) => s.closeSavedLocations);
  const savedLocations = useAppStore((s) => s.savedLocations);
  const saveLocation = useAppStore((s) => s.saveLocation);
  const removeLocation = useAppStore((s) => s.removeLocation);
  const setSelectedLocation = useAppStore((s) => s.setSelectedLocation);
  const completeOnboarding = useAppStore((s) => s.completeOnboarding);
  const router = useRouter();
  const pathname = usePathname();

  const currentSlug = pathname?.split("/").filter(Boolean)[0] || "harare";
  const [showSearch, setShowSearch] = useState(false);

  const handleSelectLocation = useCallback((slug: string) => {
    completeOnboarding();
    setSelectedLocation(slug);
    closeSavedLocations();
    if (slug !== currentSlug) {
      trackEvent("location_changed", { from: currentSlug, to: slug, method: "saved" });
      router.push(`/${slug}`);
    }
  }, [completeOnboarding, setSelectedLocation, closeSavedLocations, currentSlug, router]);

  const handleRemoveLocation = useCallback((slug: string) => {
    removeLocation(slug);
    trackEvent("location_removed", { slug });
  }, [removeLocation]);

  const handleAddLocation = useCallback((slug: string) => {
    saveLocation(slug);
    setShowSearch(false);
    trackEvent("location_saved", { slug });
  }, [saveLocation]);

  const handleOpenChange = (open: boolean) => {
    if (open) {
      trackEvent("modal_opened", { modal: "saved-locations" });
    } else {
      closeSavedLocations();
      setShowSearch(false);
    }
  };

  const atCap = savedLocations.length >= MAX_SAVED_LOCATIONS;

  return (
    <Dialog open={savedLocationsOpen} onOpenChange={handleOpenChange}>
      <DialogContent aria-describedby={undefined} className="flex h-[100dvh] flex-col p-0 sm:h-auto sm:max-h-[85vh]">
        <DialogSheetHandle />
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <DialogTitle>Locations</DialogTitle>
          <Button size="sm" onClick={() => handleOpenChange(false)}>
            Done
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {/* Current location button */}
          <div className="px-4 pt-3 pb-1">
            <CurrentLocationButton
              onResolved={handleSelectLocation}
              onSave={saveLocation}
              isSaved={(slug) => savedLocations.includes(slug)}
              atCap={atCap}
            />
          </div>

          {/* Saved locations list */}
          <div className="px-2 pt-2">
            <h3 className="px-3 pb-2 text-base font-semibold uppercase tracking-wider text-text-tertiary">
              Saved locations ({savedLocations.length}/{MAX_SAVED_LOCATIONS})
            </h3>
            {savedLocations.length === 0 ? (
              <p className="px-3 py-4 text-center text-base text-text-tertiary">
                No saved locations yet. Tap + to add locations.
              </p>
            ) : (
              <SavedLocationsList
                slugs={savedLocations}
                currentSlug={currentSlug}
                onSelect={handleSelectLocation}
                onRemove={handleRemoveLocation}
              />
            )}
          </div>

          {/* Add location section */}
          <div className="mt-auto border-t border-border px-4 pt-3 pb-4">
            {!showSearch ? (
              <Button
                variant="ghost"
                className="flex w-full min-h-[48px] items-center justify-center gap-2 text-primary"
                onClick={() => setShowSearch(true)}
                disabled={atCap}
              >
                <PlusIcon size={16} />
                <span className="font-medium">
                  {atCap ? `Limit reached (${MAX_SAVED_LOCATIONS})` : "Add location"}
                </span>
              </Button>
            ) : (
              <AddLocationSearch
                savedSlugs={savedLocations}
                onAdd={handleAddLocation}
                onCancel={() => setShowSearch(false)}
              />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Current Location Button ─────────────────────────────────────────────────

function CurrentLocationButton({
  onResolved,
  onSave,
  isSaved,
  atCap,
}: {
  onResolved: (slug: string) => void;
  onSave: (slug: string) => void;
  isSaved: (slug: string) => boolean;
  atCap: boolean;
}) {
  const [geoState, setGeoState] = useState<GeoResult | null>(null);
  const [geoLoading, setGeoLoading] = useState(false);

  const handleGeolocate = useCallback(async () => {
    setGeoLoading(true);
    const result = await detectUserLocation();
    setGeoState(result);
    setGeoLoading(false);

    if ((result.status === "success" || result.status === "created") && result.location) {
      onResolved(result.location.slug);
    }
  }, [onResolved]);

  const detectedSlug = geoState?.location?.slug;

  return (
    <div className="space-y-1">
      <div className="flex w-full min-h-[48px] items-center gap-3 rounded-[var(--radius-card)] border border-primary/25 bg-primary/5 px-4 py-3 transition-all hover:bg-primary/10">
        <button
          onClick={handleGeolocate}
          disabled={geoLoading}
          className="flex flex-1 items-center gap-3 text-left active:scale-[0.98]"
          type="button"
        >
          {geoLoading ? (
            <div className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
          ) : (
            <NavigationIcon size={18} className="shrink-0 text-primary" />
          )}
          <div className="min-w-0 flex-1">
            <span className="block text-base font-semibold text-primary">
              {geoLoading ? "Detecting..." : "Current Location"}
            </span>
            <span className="block text-base text-text-tertiary">
              {geoState?.location ? geoState.location.name : "Tap to detect your location"}
            </span>
          </div>
        </button>
        {detectedSlug && !isSaved(detectedSlug) && !atCap && (
          <button
            onClick={() => onSave(detectedSlug)}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
            aria-label="Save detected location"
            type="button"
          >
            <PlusIcon size={14} />
          </button>
        )}
      </div>
      {geoState?.status === "denied" && (
        <p className="px-1 text-base text-text-tertiary">
          Location access denied. Enable it in your browser settings.
        </p>
      )}
      {geoState?.status === "outside-supported" && (
        <p className="px-1 text-base text-text-tertiary">
          Your area isn&apos;t supported yet.
        </p>
      )}
    </div>
  );
}

// ── Saved Locations List ────────────────────────────────────────────────────

function SavedLocationsList({
  slugs,
  currentSlug,
  onSelect,
  onRemove,
}: {
  slugs: string[];
  currentSlug: string;
  onSelect: (slug: string) => void;
  onRemove: (slug: string) => void;
}) {
  const locationLabels = useAppStore((s) => s.locationLabels);
  const setLocationLabel = useAppStore((s) => s.setLocationLabel);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  // Focus the edit input when it mounts
  useEffect(() => {
    if (editingSlug) {
      const id = setTimeout(() => editInputRef.current?.focus(), 50);
      return () => clearTimeout(id);
    }
  }, [editingSlug]);

  const handleStartEdit = useCallback((slug: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingSlug(slug);
    setEditValue(locationLabels[slug] ?? "");
  }, [locationLabels]);

  const handleSaveLabel = useCallback((slug: string) => {
    setLocationLabel(slug, editValue);
    setEditingSlug(null);
  }, [editValue, setLocationLabel]);

  // Resolve slugs to location details
  const [locationMap, setLocationMap] = useState<Record<string, WeatherLocation>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (slugs.length === 0) {
      // Defer to avoid synchronous setState in effect body
      const id = requestAnimationFrame(() => setLoading(false));
      return () => cancelAnimationFrame(id);
    }

    // Fetch location details for saved slugs
    const controller = new AbortController();
    Promise.all(
      slugs.map((slug) =>
        fetch(`/api/py/locations?slug=${encodeURIComponent(slug)}`, { signal: controller.signal })
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => {
            if (data?.locations?.[0]) return [slug, data.locations[0]] as const;
            return [slug, { slug, name: slug.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()), province: "", lat: 0, lon: 0, elevation: 0, tags: [] }] as const;
          })
          .catch(() => [slug, { slug, name: slug.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()), province: "", lat: 0, lon: 0, elevation: 0, tags: [] }] as const),
      ),
    ).then((entries) => {
      const map: Record<string, WeatherLocation> = {};
      for (const [s, loc] of entries) map[s] = loc;
      setLocationMap(map);
      setLoading(false);
    });

    return () => controller.abort();
  }, [slugs]);

  if (loading) {
    return (
      <div className="space-y-1 pb-2" role="status" aria-label="Loading saved locations">
        {slugs.map((slug) => (
          <div key={slug} className="flex items-center gap-3 px-4 py-2">
            <div className="h-4 w-4 animate-pulse rounded-full bg-surface-base" />
            <div className="flex-1 space-y-1">
              <div className="h-4 w-24 animate-pulse rounded bg-surface-base" />
              <div className="h-3 w-16 animate-pulse rounded bg-surface-base" />
            </div>
          </div>
        ))}
        <span className="sr-only">Loading saved locations</span>
      </div>
    );
  }

  return (
    <ul aria-label="Saved locations" className="pb-2">
      {slugs.map((slug) => {
        const loc = locationMap[slug];
        const isActive = slug === currentSlug;
        const countryCode = ((loc?.country as string) ?? "ZW").toUpperCase();
        const contextLabel = loc?.province
          ? countryCode !== "ZW" ? `${loc.province}, ${countryCode}` : loc.province
          : "";

        const label = locationLabels[slug];
        const isEditing = editingSlug === slug;

        return (
          <li key={slug}>
            <div className="flex items-center gap-1 px-1">
              <button
                onClick={() => onSelect(slug)}
                className={`flex min-h-[48px] flex-1 items-center gap-3 rounded-[var(--radius-input)] px-3 py-2 text-base transition-all hover:bg-surface-base ${
                  isActive ? "bg-primary/10 text-primary font-semibold" : "text-text-primary"
                }`}
                type="button"
              >
                <MapPinIcon size={14} className={isActive ? "text-primary" : "text-text-tertiary"} />
                <div className="min-w-0 flex-1 text-left">
                  {isEditing ? (
                    <input
                      ref={editInputRef}
                      type="text"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => handleSaveLabel(slug)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSaveLabel(slug);
                        if (e.key === "Escape") setEditingSlug(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      placeholder="Add a label (e.g. Home)"
                      maxLength={30}
                      className="w-full rounded border border-primary/30 bg-surface-card px-2 py-0.5 text-base text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      aria-label={`Label for ${loc?.name ?? slug}`}
                    />
                  ) : (
                    <>
                      {label && (
                        <span
                          className="block truncate text-base font-medium text-text-secondary cursor-pointer hover:text-primary"
                          onClick={(e) => handleStartEdit(slug, e)}
                          role="button"
                          tabIndex={0}
                          aria-label={`Edit label for ${loc?.name ?? slug}`}
                        >
                          {label}
                        </span>
                      )}
                      <span className="block truncate">{loc?.name ?? slug}</span>
                      {contextLabel && (
                        <span className="block text-base text-text-tertiary truncate">{contextLabel}</span>
                      )}
                      {!label && (
                        <span
                          className="block text-base text-text-tertiary/60 cursor-pointer hover:text-primary truncate"
                          onClick={(e) => handleStartEdit(slug, e)}
                          role="button"
                          tabIndex={0}
                          aria-label={`Add label for ${loc?.name ?? slug}`}
                        >
                          + Add label
                        </span>
                      )}
                    </>
                  )}
                </div>
                {isActive && !isEditing && (
                  <span className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary" aria-hidden="true">
                    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" className="stroke-primary-foreground" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </span>
                )}
              </button>
              <button
                onClick={() => onRemove(slug)}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-text-tertiary hover:text-severity-severe hover:bg-severity-severe/10 transition-colors"
                aria-label={`Remove ${loc?.name ?? slug}`}
                type="button"
              >
                <TrashIcon size={16} />
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ── Add Location Search ─────────────────────────────────────────────────────

function AddLocationSearch({
  savedSlugs,
  onAdd,
  onCancel,
}: {
  savedSlugs: string[];
  onAdd: (slug: string) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WeatherLocation[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchGenRef = useRef(0);

  const debouncedQuery = useDebounce(query, 250);

  useEffect(() => {
    const id = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    const q = debouncedQuery.trim();
    if (!q) {
      // Defer to avoid synchronous setState in effect body
      const id = requestAnimationFrame(() => setResults([]));
      return () => cancelAnimationFrame(id);
    }

    const gen = ++searchGenRef.current;
    const controller = new AbortController();
    const loadId = requestAnimationFrame(() => {
      if (searchGenRef.current === gen) setLoading(true);
    });

    fetch(`/api/py/search?q=${encodeURIComponent(q)}&limit=10`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (searchGenRef.current === gen) {
          setResults(data?.locations ?? []);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && searchGenRef.current === gen) {
          setResults([]);
          setLoading(false);
        }
      });

    return () => { controller.abort(); cancelAnimationFrame(loadId); };
  }, [debouncedQuery]);

  // Filter out already-saved locations
  const filteredResults = useMemo(
    () => results.filter((loc) => !savedSlugs.includes(loc.slug)),
    [results, savedSlugs],
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search locations to add..."
            className="pl-9"
            aria-label="Search locations to add"
          />
          <SearchIcon size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
        </div>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>

      {loading && query.trim() && (
        <div className="space-y-1">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-10 animate-pulse rounded-[var(--radius-input)] bg-surface-base" role="status" aria-label="Loading">
              <span className="sr-only">Loading</span>
            </div>
          ))}
        </div>
      )}

      {!loading && filteredResults.length === 0 && query.trim() && (
        <p className="py-3 text-center text-base text-text-tertiary">
          No results for &ldquo;{query}&rdquo;
        </p>
      )}

      {filteredResults.length > 0 && (
        <ul className="space-y-0.5" aria-label="Search results">
          {filteredResults.map((loc) => {
            const countryCode = ((loc.country as string) ?? "ZW").toUpperCase();
            const contextLabel = countryCode !== "ZW"
              ? `${loc.province}, ${countryCode}`
              : loc.province;
            return (
              <li key={loc.slug}>
                <button
                  onClick={() => onAdd(loc.slug)}
                  className="flex w-full min-h-[48px] items-center gap-3 rounded-[var(--radius-input)] px-3 py-2 text-base transition-all hover:bg-surface-base text-text-primary"
                  type="button"
                >
                  <MapPinIcon size={14} className="text-text-tertiary" />
                  <div className="min-w-0 flex-1 text-left">
                    <span className="block truncate">{loc.name}</span>
                    <span className="block text-base text-text-tertiary truncate">{contextLabel}</span>
                  </div>
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden="true">
                    <PlusIcon size={14} />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
