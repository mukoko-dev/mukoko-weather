"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import {
  useAppStore,
  MAX_SAVED_LOCATIONS,
  type MyWeatherTab,
  type ThemePreference,
} from "@/lib/store";
import {
  MapPinIcon,
  SearchIcon,
  SunIcon,
  MoonIcon,
  TrashIcon,
  NavigationIcon,
} from "@/lib/weather-icons";
import { ActivityIcon } from "@/lib/weather-icons";
import { detectUserLocation, type GeoResult } from "@/lib/geolocation";
import {
  type Activity,
  type ActivityCategory,
  ACTIVITIES,
} from "@/lib/activities";
import type { ActivityCategoryDoc } from "@/lib/db";
import { CATEGORIES } from "@/lib/seed-categories";
import {
  Dialog,
  DialogContent,
  DialogSheetHandle,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLocationQuickSearch } from "@/lib/use-location-quick-search";
import {
  currentLocationSlug,
  displayNameFromSlug,
  isLocationSlug,
} from "@/lib/current-slug";
import { cn } from "@/lib/utils";
import { trackEvent } from "@/lib/analytics";
import { ForecastModel, FORECAST_MODEL_LABELS } from "@/lib/weather";
import { t } from "@/lib/i18n";
import { Spinner } from "@/components/ui/spinner";

/** Default category style for unknown categories */
const DEFAULT_CATEGORY_STYLE = {
  bg: "bg-primary/10",
  border: "border-primary",
  text: "text-primary",
  badge: "bg-primary text-primary-foreground",
};

function MonitorIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <line x1="8" x2="16" y1="21" y2="21" />
      <line x1="12" x2="12" y1="17" y2="21" />
    </svg>
  );
}

type PendingMethod = "saved" | "geolocation" | "search";

/** A location picked in this session but not yet applied. */
interface PendingLocation {
  slug: string;
  method: PendingMethod;
}

/**
 * My Weather modal — location, activities and settings.
 *
 * Contract: closing (X, Escape, overlay, the Explore link) CANCELS. It writes
 * nothing: no location change, no onboarding completion, no navigation. Only
 * the primary button commits the pending location. Header mounts this
 * component only while the modal is open, so pending state is discarded on
 * every close by construction.
 */
export function MyWeatherModal() {
  const closeMyWeather = useAppStore((s) => s.closeMyWeather);
  const completeOnboarding = useAppStore((s) => s.completeOnboarding);
  const setSelectedLocation = useAppStore((s) => s.setSelectedLocation);
  const selectedLocation = useAppStore((s) => s.selectedLocation);
  const router = useRouter();
  const pathname = usePathname();

  // The location on screen — never a hardcoded fallback city.
  const currentSlug = currentLocationSlug(pathname, selectedLocation);

  const [pending, setPending] = useState<PendingLocation | null>(null);
  const pendingSlug = pending?.slug ?? currentSlug;
  const hasPendingChange = pending !== null && pending.slug !== currentSlug;
  // Open on the tab the opener asked for (e.g. "activities"); default location.
  const initialTab = useAppStore((s) => s.myWeatherTab);
  const [activeTab, setActiveTab] = useState<MyWeatherTab>(initialTab);

  const [allActivities, setAllActivities] = useState<Activity[]>(ACTIVITIES);
  const [activityCategories, setActivityCategories] =
    useState<ActivityCategoryDoc[]>(CATEGORIES);

  // Build a category styles lookup from API data
  const categoryStyles = useMemo(() => {
    const map: Record<string, typeof DEFAULT_CATEGORY_STYLE> = {};
    for (const cat of activityCategories) {
      if (cat.style) map[cat.id] = cat.style;
    }
    return map;
  }, [activityCategories]);

  /** Get the category style or fall back to default */
  const getCategoryStyle = useCallback(
    (category: string) => {
      return categoryStyles[category] ?? DEFAULT_CATEGORY_STYLE;
    },
    [categoryStyles],
  );

  useEffect(() => {
    Promise.all([
      fetch("/api/py/activities")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data?.activities?.length) setAllActivities(data.activities);
        })
        .catch(() => {}),
      fetch("/api/py/activities?mode=categories")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data?.categories?.length) setActivityCategories(data.categories);
        })
        .catch(() => {}),
    ]);
  }, []);

  useEffect(() => {
    trackEvent("modal_opened", { modal: "my-weather" });
  }, []);

  /** Pick a location as pending. Applied only by the primary button. */
  const selectLocation = useCallback(
    (slug: string, method: PendingMethod = "saved") => {
      if (!isLocationSlug(slug)) return;
      setPending({ slug, method });
    },
    [],
  );

  /** Close without writing anything. */
  const handleCancel = () => {
    closeMyWeather();
  };

  /** Primary button: commit the pending location, then close. */
  const handleApply = () => {
    if (pendingSlug) setSelectedLocation(pendingSlug);
    completeOnboarding();
    closeMyWeather();
    if (hasPendingChange && pendingSlug) {
      trackEvent("location_changed", {
        from: currentSlug ?? "",
        to: pendingSlug,
        method: pending?.method ?? "saved",
      });
      router.push(`/${pendingSlug}`);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) handleCancel();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="flex h-[100dvh] flex-col p-0 sm:h-auto sm:max-h-[85vh]"
      >
        <DialogSheetHandle />
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <DialogTitle>My Weather</DialogTitle>
          <Button size="sm" onClick={handleApply}>
            {hasPendingChange ? "Apply" : "Done"}
          </Button>
        </div>

        {/* Tabs — Location (search + saved) first, then Activities, then Settings */}
        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as MyWeatherTab)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="shrink-0">
            <TabsTrigger value="location">Location</TabsTrigger>
            <TabsTrigger value="activities">Activities</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="location">
            <SavedTab
              pendingSlug={pendingSlug}
              currentSlug={currentSlug}
              explicitSlug={pending?.slug ?? null}
              onSelectLocation={selectLocation}
            />
          </TabsContent>

          <TabsContent value="activities">
            <ActivitiesTab
              allActivities={allActivities}
              activityCategories={activityCategories}
              getCategoryStyle={getCategoryStyle}
            />
          </TabsContent>

          <TabsContent value="settings">
            <SettingsTab />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// ── Location Tab (search + saved) ──────────────────────────────────────────

function SavedTab({
  pendingSlug,
  currentSlug,
  explicitSlug,
  onSelectLocation,
}: {
  /** Effective selection: the picked location, or the current one. */
  pendingSlug: string | null;
  /** The location on screen (first path segment, or the store selection). */
  currentSlug: string | null;
  /** Only a location the user actually picked in this session (or null). */
  explicitSlug: string | null;
  onSelectLocation: (slug: string, method?: PendingMethod) => void;
}) {
  const savedLocations = useAppStore((s) => s.savedLocations);
  const locationLabels = useAppStore((s) => s.locationLabels);
  const saveLocation = useAppStore((s) => s.saveLocation);
  const removeLocation = useAppStore((s) => s.removeLocation);
  const setLocationLabel = useAppStore((s) => s.setLocationLabel);
  const closeMyWeather = useAppStore((s) => s.closeMyWeather);
  const locationNames = useAppStore((s) => s.locationNames);
  const rememberLocationName = useAppStore((s) => s.rememberLocationName);

  /** Real name when seen this session, otherwise a readable name from the slug. */
  const nameFor = (slug: string) =>
    locationNames[slug] ?? displayNameFromSlug(slug);

  const [geoState, setGeoState] = useState<GeoResult | null>(null);
  const [geoLoading, setGeoLoading] = useState(false);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  // Location search — always visible. Tapping a result SELECTS it (pending,
  // applied by the primary button). Saving is a separate explicit action.
  const { query, setQuery, results, loading } = useLocationQuickSearch();
  const searchInputRef = useRef<HTMLInputElement>(null);

  const atCap = savedLocations.length >= MAX_SAVED_LOCATIONS;

  // Focus the search on desktop only. On touch devices focusing an input
  // raises the on-screen keyboard over the list before the user asked for it.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    if (!window.matchMedia("(pointer: fine)").matches) return;
    const id = window.setTimeout(() => searchInputRef.current?.focus(), 50);
    return () => window.clearTimeout(id);
  }, []);

  // Focus edit input when editing starts
  useEffect(() => {
    if (editingSlug) {
      setTimeout(() => editInputRef.current?.focus(), 50);
    }
  }, [editingSlug]);

  const handleGeolocate = useCallback(async () => {
    setGeoLoading(true);
    const result = await detectUserLocation({ autoCreate: true });
    setGeoState(result);
    setGeoLoading(false);
    if (
      (result.status === "success" || result.status === "created") &&
      result.location
    ) {
      // Selects only — the user decides whether to save it.
      rememberLocationName(result.location.slug, result.location.name);
      onSelectLocation(result.location.slug, "geolocation");
    }
  }, [onSelectLocation, rememberLocationName]);

  const handleSaveLabel = useCallback(
    (slug: string, value: string) => {
      setLocationLabel(slug, value);
      setEditingSlug(null);
    },
    [setLocationLabel],
  );

  const titleCase = nameFor;

  return (
    <div className="flex flex-col gap-2">
      {/* Search — visible immediately when the modal opens */}
      <div className="px-4 pt-3">
        <div className="relative">
          <SearchIcon
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
            aria-hidden="true"
          />
          <Input
            ref={searchInputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search for a location..."
            className="pl-9"
            aria-label="Search for a location"
          />
        </div>

        {loading && (
          <div
            className="mt-2 h-10 animate-pulse rounded-[var(--radius-input)] bg-surface-base"
            role="status"
            aria-label="Loading"
          >
            <span className="sr-only">Loading</span>
          </div>
        )}
        {!loading && query.trim() && results.length === 0 && (
          <p className="py-2 text-center text-base text-text-tertiary">
            No results for &ldquo;{query}&rdquo;
          </p>
        )}
        {results.length > 0 && (
          <ul aria-label="Search results" className="mt-2 space-y-1">
            {results.map((loc) => {
              const isSaved = savedLocations.includes(loc.slug);
              const isSelected = loc.slug === pendingSlug;
              return (
                <li key={loc.slug} className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      rememberLocationName(loc.slug, loc.name);
                      onSelectLocation(loc.slug, "search");
                    }}
                    aria-pressed={isSelected}
                    className={`flex min-h-[var(--touch-target-min)] min-w-0 flex-1 items-center gap-3 rounded-[var(--radius-input)] px-3 py-2 text-left text-base text-text-primary transition-colors ${
                      isSelected ? "bg-primary/10" : "hover:bg-surface-base"
                    }`}
                  >
                    <MapPinIcon
                      size={14}
                      className={
                        isSelected ? "text-primary" : "text-text-tertiary"
                      }
                    />
                    <div className="min-w-0 flex-1">
                      <span className="block truncate">{loc.name}</span>
                      {loc.province && (
                        <span className="block truncate text-base text-text-tertiary">
                          {loc.province}
                        </span>
                      )}
                    </div>
                  </button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      rememberLocationName(loc.slug, loc.name);
                      saveLocation(loc.slug);
                    }}
                    disabled={isSaved || atCap}
                    aria-label={
                      isSaved ? `${loc.name} is saved` : `Save ${loc.name}`
                    }
                    className="shrink-0 min-h-[var(--touch-target-min)] text-primary"
                  >
                    {isSaved ? "Saved" : "Save"}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Geolocation — selects the detected location, does not save it */}
      <div className="px-4">
        <Button
          variant="ghost"
          onClick={handleGeolocate}
          disabled={geoLoading}
          className="flex min-h-[var(--touch-target-min)] w-full items-center justify-start gap-3 text-primary"
        >
          {geoLoading ? (
            <Spinner className="border-primary/30 border-t-primary" />
          ) : (
            <NavigationIcon size={16} className="text-primary" />
          )}
          <span className="font-medium">
            {geoLoading ? "Detecting..." : "Use my current location"}
          </span>
        </Button>
        {geoState?.status === "denied" && (
          <p className="px-3 pb-1 text-base text-text-tertiary">
            {t("geo.denied")}
          </p>
        )}
        {geoState?.status === "error" && geoState?.coords && (
          <p className="px-3 pb-1 text-base text-text-tertiary">
            {t("geo.error")}
          </p>
        )}
      </div>

      {/* The location on screen, when it is not saved — always selectable */}
      {currentSlug && !savedLocations.includes(currentSlug) && (
        <div className="px-4">
          <p className="mb-1 text-base font-medium text-text-secondary">
            Current
          </p>
          <button
            type="button"
            onClick={() => onSelectLocation(currentSlug)}
            aria-pressed={pendingSlug === currentSlug}
            className={`flex min-h-[var(--touch-target-min)] w-full items-center gap-3 rounded-[var(--radius-card)] px-3 py-2 text-left text-base text-text-primary transition-colors ${
              pendingSlug === currentSlug
                ? "bg-primary/10"
                : "hover:bg-surface-base"
            }`}
          >
            <MapPinIcon
              size={14}
              className={
                pendingSlug === currentSlug
                  ? "text-primary"
                  : "text-text-tertiary"
              }
            />
            <span className="min-w-0 flex-1 truncate font-medium">
              {nameFor(currentSlug)}
            </span>
          </button>
        </div>
      )}

      {/* A picked location that is not saved yet */}
      {explicitSlug && !savedLocations.includes(explicitSlug) && (
        <p
          className="px-4 text-base text-text-secondary"
          role="status"
          aria-live="polite"
        >
          Selected:{" "}
          <span className="font-medium">{titleCase(explicitSlug)}</span>
        </p>
      )}

      {/* Saved locations list */}
      <div className="px-4 pb-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-base font-medium text-text-secondary">
            {savedLocations.length}/{MAX_SAVED_LOCATIONS} saved
          </span>
        </div>

        {savedLocations.length === 0 && (
          <p className="py-4 text-center text-base text-text-tertiary">
            No saved locations yet. Search above and tap Save to keep one here.
          </p>
        )}

        <ul aria-label="Saved locations" className="space-y-1">
          {savedLocations.map((slug) => {
            const label = locationLabels[slug];
            const isSelected = slug === pendingSlug;

            return (
              <li key={slug} className="group">
                <div
                  className={`flex items-center gap-2 rounded-[var(--radius-card)] px-3 py-2 min-h-[var(--touch-target-min)] transition-colors ${
                    isSelected ? "bg-primary/10" : "hover:bg-surface-base"
                  }`}
                >
                  <button
                    onClick={() => onSelectLocation(slug)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    type="button"
                  >
                    <MapPinIcon
                      size={14}
                      className={
                        isSelected ? "text-primary" : "text-text-tertiary"
                      }
                    />
                    <div className="min-w-0 flex-1">
                      {editingSlug === slug ? (
                        <Input
                          ref={editInputRef}
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={() => handleSaveLabel(slug, editValue)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter")
                              handleSaveLabel(slug, editValue);
                            if (e.key === "Escape") setEditingSlug(null);
                          }}
                          placeholder="Label (e.g. Home)"
                          className="h-8 text-base"
                          aria-label={`Label for ${titleCase(slug)}`}
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <>
                          {label && (
                            <span className="block text-base font-semibold text-text-primary truncate">
                              {label}
                            </span>
                          )}
                          <span
                            className={`block truncate ${label ? "text-base text-text-tertiary" : "text-base font-medium text-text-primary"}`}
                          >
                            {titleCase(slug)}
                          </span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditValue(label || "");
                              setEditingSlug(slug);
                            }}
                            className="dikdik"
                            type="button"
                          >
                            {label ? "Edit label" : "+ Add label"}
                          </button>
                        </>
                      )}
                    </div>
                    {isSelected && (
                      <span
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary"
                        aria-hidden="true"
                      >
                        <svg
                          width={12}
                          height={12}
                          viewBox="0 0 24 24"
                          fill="none"
                          className="stroke-primary-foreground"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      </span>
                    )}
                  </button>
                  <Button
                    onClick={() => removeLocation(slug)}
                    aria-label={`Remove ${titleCase(slug)}`}
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 text-text-tertiary hover:bg-severity-severe/10 hover:text-severity-severe"
                    type="button"
                  >
                    <TrashIcon size={14} />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Explore link */}
      <div className="px-4 pb-3">
        <Link
          href="/explore"
          prefetch={false}
          onClick={closeMyWeather}
          className="flex items-center gap-2 rounded-[var(--radius-input)] border border-primary/10 bg-primary/5 px-3 py-2.5 min-h-[var(--touch-target-min)] text-base font-medium text-primary hover:bg-primary/10 transition-colors"
        >
          <SearchIcon size={14} className="text-primary" aria-hidden="true" />
          Discover more locations on Explore
        </Link>
      </div>
    </div>
  );
}

// ── Activities Tab ─────────────────────────────────────────────────────────

function ActivitiesTab({
  allActivities,
  activityCategories,
  getCategoryStyle,
}: {
  allActivities: Activity[];
  activityCategories: ActivityCategoryDoc[];
  getCategoryStyle: (category: string) => {
    bg: string;
    border: string;
    text: string;
    badge: string;
  };
}) {
  const selectedActivities = useAppStore((s) => s.selectedActivities);
  const toggleActivity = useAppStore((s) => s.toggleActivity);
  const [activeCategory, setActiveCategory] = useState<
    ActivityCategory | "all"
  >("all");
  const [activityQuery, setActivityQuery] = useState("");

  // Filtered activities
  const filteredActivities = useMemo(() => {
    let items = allActivities;
    if (activityQuery) {
      const q = activityQuery.toLowerCase().trim();
      items = items.filter(
        (a) =>
          a.label.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q) ||
          a.category.includes(q),
      );
    }
    if (activeCategory !== "all") {
      items = items.filter((a) => a.category === activeCategory);
    }
    return items;
  }, [activityQuery, activeCategory, allActivities]);

  return (
    <div className="flex flex-col gap-1">
      <div className="px-4 pt-3 pb-1">
        <h4 className="giraffe">
          Select activities for personalised weather insights
          {selectedActivities.length > 0 && (
            <span className="ml-2 text-base font-normal text-text-tertiary">
              ({selectedActivities.length} selected)
            </span>
          )}
        </h4>
      </div>

      {/* Category filter pills — 44px touch targets */}
      <ToggleGroup
        type="single"
        value={activeCategory}
        onValueChange={(val) => {
          if (val) setActiveCategory(val as ActivityCategory | "all");
        }}
        variant="unstyled"
        className="flex gap-2 overflow-x-auto px-4 pt-1 pb-2 scrollbar-hide [overscroll-behavior-x:contain]"
        aria-label="Activity categories"
      >
        <ToggleGroupItem
          value="all"
          className={cn(
            "shrink-0 rounded-[var(--radius-badge)] px-4 py-2 min-h-[var(--touch-target-min)] text-base font-medium transition-colors",
            activeCategory === "all"
              ? "bg-primary text-primary-foreground"
              : "bg-surface-base text-text-secondary hover:text-text-primary",
          )}
        >
          All
        </ToggleGroupItem>
        {activityCategories.map((cat) => {
          const style = getCategoryStyle(cat.id);
          return (
            <ToggleGroupItem
              key={cat.id}
              value={cat.id}
              className={cn(
                "shrink-0 rounded-[var(--radius-badge)] px-4 py-2 min-h-[var(--touch-target-min)] text-base font-medium transition-colors",
                activeCategory === cat.id
                  ? style.badge
                  : "bg-surface-base text-text-secondary hover:text-text-primary",
              )}
            >
              {cat.label}
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>

      {/* Activity search */}
      <div className="px-4 pb-2">
        <div className="relative">
          <SearchIcon
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 shrink-0 text-text-tertiary"
          />
          <Input
            type="text"
            value={activityQuery}
            onChange={(e) => setActivityQuery(e.target.value)}
            placeholder="Search activities..."
            className="pl-9"
            aria-label="Search activities"
          />
        </div>
      </div>

      {/* Activity grid */}
      <div className="px-4 pb-4">
        <div
          className="grid grid-cols-2 gap-2.5"
          role="group"
          aria-label="Available activities"
        >
          {filteredActivities.map((activity) => {
            const isSelected = selectedActivities.includes(activity.id);
            const style = getCategoryStyle(activity.category);
            return (
              <button
                key={activity.id}
                onClick={() => {
                  toggleActivity(activity.id);
                  trackEvent("activity_toggled", {
                    activityId: activity.id,
                    enabled: !isSelected,
                  });
                }}
                aria-pressed={isSelected}
                aria-label={`${activity.label}: ${activity.description}`}
                className={`press-scale relative flex min-h-[88px] flex-col items-center justify-center gap-2 rounded-[var(--radius-card)] border-2 p-3 transition-all ${
                  isSelected
                    ? `${style.border} ${style.bg} shadow-sm`
                    : "border-transparent bg-surface-base hover:border-text-tertiary/30"
                }`}
              >
                {isSelected && (
                  <span
                    className={`absolute top-1.5 right-1.5 flex h-5 w-5 items-center justify-center rounded-full animate-[scale-in_200ms_ease-out] ${style.badge}`}
                    aria-hidden="true"
                  >
                    <svg
                      width={12}
                      height={12}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </span>
                )}
                <ActivityIcon
                  activity={activity.id}
                  icon={activity.icon}
                  size={28}
                  className={isSelected ? style.text : "text-text-tertiary"}
                />
                <span
                  className={`text-base font-medium ${isSelected ? style.text : "text-text-secondary"}`}
                >
                  {activity.label}
                </span>
              </button>
            );
          })}
        </div>

        {filteredActivities.length === 0 && activityQuery && (
          <p className="py-8 text-center text-base text-text-tertiary">
            No activities found for &ldquo;{activityQuery}&rdquo;
          </p>
        )}
      </div>
    </div>
  );
}

// ── Settings Tab ────────────────────────────────────────────────────────────

const THEME_OPTIONS: {
  value: ThemePreference;
  label: string;
  description: string;
}[] = [
  { value: "light", label: "Light", description: "Always use light mode" },
  { value: "dark", label: "Dark", description: "Always use dark mode" },
  {
    value: "system",
    label: "System",
    description: "Follow your device setting",
  },
];

function SettingsTab() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);

  return (
    <div className="p-4">
      <h4 className="giraffe mb-3">Appearance</h4>
      <div
        className="space-y-2"
        role="radiogroup"
        aria-label="Theme preference"
      >
        {THEME_OPTIONS.map((option) => (
          <button
            key={option.value}
            role="radio"
            aria-checked={theme === option.value}
            onClick={() => {
              setTheme(option.value);
              trackEvent("theme_changed", { theme: option.value });
            }}
            className={`press-scale flex w-full min-h-[var(--touch-target-min)] items-center gap-3 rounded-[var(--radius-card)] border-2 px-4 py-3 text-left transition-all ${
              theme === option.value
                ? "border-primary bg-primary/5 shadow-sm"
                : "border-transparent bg-surface-base hover:border-text-tertiary/30"
            }`}
          >
            <span
              className={
                theme === option.value ? "text-primary" : "text-text-tertiary"
              }
              aria-hidden="true"
            >
              {option.value === "light" && <SunIcon size={20} />}
              {option.value === "dark" && <MoonIcon size={20} />}
              {option.value === "system" && <MonitorIcon size={20} />}
            </span>
            <div>
              <p
                className={`text-base font-medium ${theme === option.value ? "text-primary" : "text-text-primary"}`}
              >
                {option.label}
              </p>
              <p className="text-base text-text-tertiary">
                {option.description}
              </p>
            </div>
            {theme === option.value && (
              <span
                className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-primary animate-[scale-in_200ms_ease-out]"
                aria-hidden="true"
              >
                <svg
                  width={12}
                  height={12}
                  viewBox="0 0 24 24"
                  fill="none"
                  className="stroke-primary-foreground"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </span>
            )}
          </button>
        ))}
      </div>

      <ModelSelector />

      <p className="mt-4 text-base text-text-tertiary">
        Your preferences are saved on this device.
      </p>
    </div>
  );
}

// ── Forecast model selector ─────────────────────────────────────────────────

/** Auto (best_match) first, then the individual national/agency models. */
const MODEL_OPTIONS: { value: ForecastModel; label: string }[] = [
  {
    value: ForecastModel.BestMatch,
    label: FORECAST_MODEL_LABELS[ForecastModel.BestMatch],
  },
  { value: ForecastModel.GFS, label: FORECAST_MODEL_LABELS[ForecastModel.GFS] },
  {
    value: ForecastModel.ECMWF,
    label: FORECAST_MODEL_LABELS[ForecastModel.ECMWF],
  },
  {
    value: ForecastModel.ICON,
    label: FORECAST_MODEL_LABELS[ForecastModel.ICON],
  },
  {
    value: ForecastModel.MeteoFrance,
    label: FORECAST_MODEL_LABELS[ForecastModel.MeteoFrance],
  },
];

function ModelSelector() {
  const selectedForecastModel = useAppStore((s) => s.selectedForecastModel);
  const setSelectedForecastModel = useAppStore(
    (s) => s.setSelectedForecastModel,
  );

  return (
    <div className="mt-6">
      <h4 className="giraffe mb-1">Forecast model</h4>
      <p className="mb-3 text-base text-text-tertiary">
        Choose which weather model to highlight. &ldquo;Auto&rdquo; blends the
        best available model for your location.
      </p>
      <div
        className="space-y-2"
        role="radiogroup"
        aria-label="Forecast model preference"
      >
        {MODEL_OPTIONS.map((option) => {
          const isSelected = selectedForecastModel === option.value;
          return (
            <button
              key={option.value}
              role="radio"
              aria-checked={isSelected}
              onClick={() => setSelectedForecastModel(option.value)}
              className={`press-scale flex w-full min-h-[var(--touch-target-min)] items-center gap-3 rounded-[var(--radius-card)] border-2 px-4 py-3 text-left transition-all ${
                isSelected
                  ? "border-primary bg-primary/5 shadow-sm"
                  : "border-transparent bg-surface-base hover:border-text-tertiary/30"
              }`}
            >
              <p
                className={`text-base font-medium ${isSelected ? "text-primary" : "text-text-primary"}`}
              >
                {option.label}
              </p>
              {isSelected && (
                <span
                  className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-primary animate-[scale-in_200ms_ease-out]"
                  aria-hidden="true"
                >
                  <svg
                    width={12}
                    height={12}
                    viewBox="0 0 24 24"
                    fill="none"
                    className="stroke-primary-foreground"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
