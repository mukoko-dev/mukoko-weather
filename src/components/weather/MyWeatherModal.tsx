"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { useAppStore, MAX_SAVED_LOCATIONS, type ThemePreference } from "@/lib/store";
import { MapPinIcon, SearchIcon, SunIcon, MoonIcon, TrashIcon, NavigationIcon } from "@/lib/weather-icons";
import { ActivityIcon } from "@/lib/weather-icons";
import { detectUserLocation, type GeoResult } from "@/lib/geolocation";
import {
  type Activity,
  type ActivityCategory,
  ACTIVITIES,
} from "@/lib/activities";
import type { ActivityCategoryDoc } from "@/lib/db";
import { CATEGORIES } from "@/lib/seed-categories";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDebounce } from "@/lib/use-debounce";
import { cn } from "@/lib/utils";

/** Default category style for unknown categories */
const DEFAULT_CATEGORY_STYLE = {
  bg: "bg-primary/10", border: "border-primary", text: "text-primary",
  badge: "bg-primary text-primary-foreground",
};

function MonitorIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <line x1="8" x2="16" y1="21" y2="21" />
      <line x1="12" x2="12" y1="17" y2="21" />
    </svg>
  );
}

/** Debounce hook — returns the debounced value after delay ms */
export function MyWeatherModal() {
  const closeMyWeather = useAppStore((s) => s.closeMyWeather);
  const myWeatherOpen = useAppStore((s) => s.myWeatherOpen);
  const completeOnboarding = useAppStore((s) => s.completeOnboarding);
  const setSelectedLocation = useAppStore((s) => s.setSelectedLocation);
  const router = useRouter();
  const pathname = usePathname();

  const currentSlug = pathname?.replace("/", "") || "harare";
  const [pendingSlug, setPendingSlug] = useState(currentSlug);
  const [activeTab, setActiveTab] = useState("saved");

  const [allActivities, setAllActivities] = useState<Activity[]>(ACTIVITIES);
  const [activityCategories, setActivityCategories] = useState<ActivityCategoryDoc[]>(CATEGORIES);

  // Build a category styles lookup from API data
  const categoryStyles = useMemo(() => {
    const map: Record<string, typeof DEFAULT_CATEGORY_STYLE> = {};
    for (const cat of activityCategories) {
      if (cat.style) map[cat.id] = cat.style;
    }
    return map;
  }, [activityCategories]);

  /** Get the category style or fall back to default */
  const getCategoryStyle = useCallback((category: string) => {
    return categoryStyles[category] ?? DEFAULT_CATEGORY_STYLE;
  }, [categoryStyles]);

  useEffect(() => {
    Promise.all([
      fetch("/api/py/activities")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => { if (data?.activities?.length) setAllActivities(data.activities); })
        .catch(() => {}),
      fetch("/api/py/activities?mode=categories")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => { if (data?.categories?.length) setActivityCategories(data.categories); })
        .catch(() => {}),
    ]);
  }, []);

  const handleDone = () => {
    completeOnboarding();
    closeMyWeather();
    setSelectedLocation(pendingSlug);
    if (pendingSlug !== currentSlug) {
      router.push(`/${pendingSlug}`);
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (open) {
      setPendingSlug(currentSlug);
      setActiveTab("saved");
    } else {
      handleDone();
    }
  };

  /** When user selects a location from saved, navigate and close */
  const handleSelectSavedLocation = useCallback((slug: string) => {
    setPendingSlug(slug);
  }, []);

  const locationChanged = pendingSlug !== currentSlug;

  return (
    <Dialog open={myWeatherOpen} onOpenChange={handleOpenChange}>
      <DialogContent aria-describedby={undefined} className="flex h-[100dvh] flex-col p-0 sm:h-auto sm:max-h-[85vh]">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <DialogTitle>My Weather</DialogTitle>
          <Button size="sm" onClick={handleDone}>
            {locationChanged ? "Apply" : "Done"}
          </Button>
        </div>

        {/* Tabs — Saved locations first, then Activities, then Settings */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="shrink-0">
            <TabsTrigger value="saved">Saved</TabsTrigger>
            <TabsTrigger value="activities">Activities</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="saved">
            <SavedTab
              pendingSlug={pendingSlug}
              onSelectLocation={handleSelectSavedLocation}
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

// ── Saved Locations Tab ─────────────────────────────────────────────────────

function SavedTab({
  pendingSlug,
  onSelectLocation,
}: {
  pendingSlug: string;
  onSelectLocation: (slug: string) => void;
}) {
  const savedLocations = useAppStore((s) => s.savedLocations);
  const locationLabels = useAppStore((s) => s.locationLabels);
  const saveLocation = useAppStore((s) => s.saveLocation);
  const removeLocation = useAppStore((s) => s.removeLocation);
  const setLocationLabel = useAppStore((s) => s.setLocationLabel);
  const closeMyWeather = useAppStore((s) => s.closeMyWeather);

  const [geoState, setGeoState] = useState<GeoResult | null>(null);
  const [geoLoading, setGeoLoading] = useState(false);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  // Add location search
  const [showAdd, setShowAdd] = useState(false);
  const [addQuery, setAddQuery] = useState("");
  const debouncedAddQuery = useDebounce(addQuery, 300);
  const [addResults, setAddResults] = useState<{ slug: string; name: string; province: string; country?: string }[]>([]);
  const [addLoading, setAddLoading] = useState(false);
  const addInputRef = useRef<HTMLInputElement>(null);

  const atCap = savedLocations.length >= MAX_SAVED_LOCATIONS;

  // Focus edit input when editing starts
  useEffect(() => {
    if (editingSlug) {
      setTimeout(() => editInputRef.current?.focus(), 50);
    }
  }, [editingSlug]);

  // Focus add input when add mode opens
  useEffect(() => {
    if (showAdd) {
      const t = setTimeout(() => addInputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [showAdd]);

  // Search for locations to add
  useEffect(() => {
    const q = debouncedAddQuery.trim();
    if (!q) {
      const t = requestAnimationFrame(() => { setAddResults([]); });
      return () => cancelAnimationFrame(t);
    }

    const controller = new AbortController();
    const run = async () => {
      setAddLoading(true);
      try {
        const res = await fetch(`/api/py/search?q=${encodeURIComponent(q)}&limit=10`, { signal: controller.signal });
        const data = res.ok ? await res.json() : null;
        const locs = (data?.locations ?? []).filter(
          (l: { slug: string }) => !savedLocations.includes(l.slug),
        );
        setAddResults(locs);
      } catch {
        if (!controller.signal.aborted) { setAddResults([]); }
      } finally {
        if (!controller.signal.aborted) { setAddLoading(false); }
      }
    };
    run();
    return () => controller.abort();
  }, [debouncedAddQuery, savedLocations]);

  const handleGeolocate = useCallback(async () => {
    setGeoLoading(true);
    const result = await detectUserLocation();
    setGeoState(result);
    setGeoLoading(false);
    if ((result.status === "success" || result.status === "created") && result.location) {
      saveLocation(result.location.slug);
      onSelectLocation(result.location.slug);
    }
  }, [onSelectLocation, saveLocation]);

  const handleSaveLabel = useCallback((slug: string, value: string) => {
    setLocationLabel(slug, value);
    setEditingSlug(null);
  }, [setLocationLabel]);

  const titleCase = (s: string) => s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <div className="flex flex-col gap-2">
      {/* Geolocation button */}
      <div className="px-4 pt-3">
        <Button
          variant="ghost"
          onClick={handleGeolocate}
          disabled={geoLoading}
          className="flex min-h-[44px] w-full items-center justify-start gap-3 text-primary"
        >
          {geoLoading ? (
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
          ) : (
            <NavigationIcon size={16} className="text-primary" />
          )}
          <span className="font-medium">
            {geoLoading ? "Detecting..." : "Use my current location"}
          </span>
        </Button>
        {geoState?.status === "denied" && (
          <p className="px-3 pb-1 text-base text-text-tertiary">Location access denied.</p>
        )}
        {geoState?.status === "outside-supported" && (
          <p className="px-3 pb-1 text-base text-text-tertiary">Your area isn&apos;t supported yet.</p>
        )}
      </div>

      {/* Saved locations list */}
      <div className="px-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-base font-medium text-text-secondary">
            {savedLocations.length}/{MAX_SAVED_LOCATIONS} saved
          </span>
          {!showAdd && (
            <Button variant="ghost" size="sm" onClick={() => setShowAdd(true)} disabled={atCap}
              className="text-primary min-h-[44px]">
              + Add location
            </Button>
          )}
        </div>

        {savedLocations.length === 0 && !showAdd && (
          <p className="py-6 text-center text-base text-text-tertiary">
            No saved locations yet. Add one or use geolocation above.
          </p>
        )}

        <ul aria-label="Saved locations" className="space-y-1">
          {savedLocations.map((slug) => {
            const label = locationLabels[slug];
            const isSelected = slug === pendingSlug;

            return (
              <li key={slug} className="group">
                <div className={`flex items-center gap-2 rounded-[var(--radius-card)] px-3 py-2 min-h-[44px] transition-colors ${
                  isSelected ? "bg-primary/10" : "hover:bg-surface-base"
                }`}>
                  <button
                    onClick={() => onSelectLocation(slug)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    type="button"
                  >
                    <MapPinIcon size={14} className={isSelected ? "text-primary" : "text-text-tertiary"} />
                    <div className="min-w-0 flex-1">
                      {editingSlug === slug ? (
                        <Input
                          ref={editInputRef}
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={() => handleSaveLabel(slug, editValue)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleSaveLabel(slug, editValue);
                            if (e.key === "Escape") setEditingSlug(null);
                          }}
                          placeholder="Label (e.g. Home)"
                          className="h-8 text-base"
                          aria-label={`Label for ${titleCase(slug)}`}
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <>
                          {label && <span className="block text-base font-semibold text-text-primary truncate">{label}</span>}
                          <span className={`block truncate ${label ? "text-base text-text-tertiary" : "text-base font-medium text-text-primary"}`}>
                            {titleCase(slug)}
                          </span>
                          <button
                            onClick={(e) => { e.stopPropagation(); setEditValue(label || ""); setEditingSlug(slug); }}
                            className="text-base text-primary/60 hover:text-primary"
                            type="button"
                          >
                            {label ? "Edit label" : "+ Add label"}
                          </button>
                        </>
                      )}
                    </div>
                    {isSelected && (
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary" aria-hidden="true">
                        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" className="stroke-primary-foreground" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                      </span>
                    )}
                  </button>
                  <button
                    onClick={() => removeLocation(slug)}
                    aria-label={`Remove ${titleCase(slug)}`}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-tertiary hover:text-severity-severe hover:bg-severity-severe/10 transition-colors"
                    type="button"
                  >
                    <TrashIcon size={14} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Add location search */}
      {showAdd && (
        <div className="px-4 pb-3">
          <div className="relative mb-2">
            <SearchIcon size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
            <Input
              ref={addInputRef}
              value={addQuery}
              onChange={(e) => setAddQuery(e.target.value)}
              placeholder="Search locations to add..."
              className="pl-9"
              aria-label="Search locations to add"
            />
          </div>
          {addLoading && <div className="h-10 animate-pulse rounded-[var(--radius-input)] bg-surface-base" role="status" aria-label="Loading"><span className="sr-only">Loading</span></div>}
          {!addLoading && addQuery.trim() && addResults.length === 0 && (
            <p className="py-2 text-center text-base text-text-tertiary">No results for &ldquo;{addQuery}&rdquo;</p>
          )}
          <ul aria-label="Search results" className="space-y-1">
            {addResults.map((loc) => (
              <li key={loc.slug}>
                <button
                  onClick={() => { saveLocation(loc.slug); setAddQuery(""); setAddResults([]); }}
                  className="flex w-full min-h-[44px] items-center gap-3 rounded-[var(--radius-input)] px-3 py-2 text-base text-text-primary hover:bg-surface-base transition-colors"
                  type="button"
                >
                  <MapPinIcon size={14} className="text-text-tertiary" />
                  <div className="min-w-0 flex-1 text-left">
                    <span className="block truncate">{loc.name}</span>
                    <span className="block text-base text-text-tertiary truncate">{loc.province}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <Button variant="ghost" size="sm" onClick={() => { setShowAdd(false); setAddQuery(""); setAddResults([]); }}
            className="mt-1 text-text-tertiary">
            Cancel
          </Button>
        </div>
      )}

      {/* Explore link */}
      <div className="px-4 pb-3">
        <Link
          href="/explore"
          prefetch={false}
          onClick={closeMyWeather}
          className="flex items-center gap-2 rounded-[var(--radius-input)] border border-primary/10 bg-primary/5 px-3 py-2.5 min-h-[44px] text-base font-medium text-primary hover:bg-primary/10 transition-colors"
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
  getCategoryStyle: (category: string) => { bg: string; border: string; text: string; badge: string };
}) {
  const selectedActivities = useAppStore((s) => s.selectedActivities);
  const toggleActivity = useAppStore((s) => s.toggleActivity);
  const [activeCategory, setActiveCategory] = useState<ActivityCategory | "all">("all");
  const [activityQuery, setActivityQuery] = useState("");

  // Filtered activities
  const filteredActivities = useMemo(() => {
    let items = allActivities;
    if (activityQuery) {
      const q = activityQuery.toLowerCase().trim();
      items = items.filter(
        (a) => a.label.toLowerCase().includes(q) || a.description.toLowerCase().includes(q) || a.category.includes(q),
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
        <h4 className="text-base font-semibold text-text-primary">
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
        onValueChange={(val) => { if (val) setActiveCategory(val as ActivityCategory | "all"); }}
        variant="unstyled"
        className="flex gap-2 overflow-x-auto px-4 pt-1 pb-2 scrollbar-hide [overscroll-behavior-x:contain]"
        aria-label="Activity categories"
      >
        <ToggleGroupItem
          value="all"
          className={cn(
            "shrink-0 rounded-[var(--radius-badge)] px-4 py-2 min-h-[44px] text-base font-medium transition-colors",
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
                "shrink-0 rounded-[var(--radius-badge)] px-4 py-2 min-h-[44px] text-base font-medium transition-colors",
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
          <SearchIcon size={16} className="absolute left-3 top-1/2 -translate-y-1/2 shrink-0 text-text-tertiary" />
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
        <div className="grid grid-cols-2 gap-2.5" role="group" aria-label="Available activities">
          {filteredActivities.map((activity) => {
            const isSelected = selectedActivities.includes(activity.id);
            const style = getCategoryStyle(activity.category);
            return (
              <button
                key={activity.id}
                onClick={() => toggleActivity(activity.id)}
                aria-pressed={isSelected}
                aria-label={`${activity.label}: ${activity.description}`}
                className={`press-scale relative flex min-h-[88px] flex-col items-center justify-center gap-2 rounded-[var(--radius-card)] border-2 p-3 transition-all ${
                  isSelected
                    ? `${style.border} ${style.bg} shadow-sm`
                    : "border-transparent bg-surface-base hover:border-text-tertiary/30"
                }`}
              >
                {isSelected && (
                  <span className={`absolute top-1.5 right-1.5 flex h-5 w-5 items-center justify-center rounded-full animate-[scale-in_200ms_ease-out] ${style.badge}`} aria-hidden="true">
                    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
                <span className={`text-base font-medium ${isSelected ? style.text : "text-text-secondary"}`}>
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

const THEME_OPTIONS: { value: ThemePreference; label: string; description: string }[] = [
  { value: "light", label: "Light", description: "Always use light mode" },
  { value: "dark", label: "Dark", description: "Always use dark mode" },
  { value: "system", label: "System", description: "Follow your device setting" },
];

function SettingsTab() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);

  return (
    <div className="p-4">
      <h4 className="mb-3 text-base font-semibold text-text-primary">Appearance</h4>
      <div className="space-y-2" role="radiogroup" aria-label="Theme preference">
        {THEME_OPTIONS.map((option) => (
          <button
            key={option.value}
            role="radio"
            aria-checked={theme === option.value}
            onClick={() => setTheme(option.value)}
            className={`press-scale flex w-full min-h-[44px] items-center gap-3 rounded-[var(--radius-card)] border-2 px-4 py-3 text-left transition-all ${
              theme === option.value
                ? "border-primary bg-primary/5 shadow-sm"
                : "border-transparent bg-surface-base hover:border-text-tertiary/30"
            }`}
          >
            <span className={theme === option.value ? "text-primary" : "text-text-tertiary"} aria-hidden="true">
              {option.value === "light" && <SunIcon size={20} />}
              {option.value === "dark" && <MoonIcon size={20} />}
              {option.value === "system" && <MonitorIcon size={20} />}
            </span>
            <div>
              <p className={`text-base font-medium ${theme === option.value ? "text-primary" : "text-text-primary"}`}>
                {option.label}
              </p>
              <p className="text-base text-text-tertiary">{option.description}</p>
            </div>
            {theme === option.value && (
              <span className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-primary animate-[scale-in_200ms_ease-out]" aria-hidden="true">
                <svg width={12} height={12} viewBox="0 0 24 24" fill="none" className="stroke-primary-foreground" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </span>
            )}
          </button>
        ))}
      </div>

      <p className="mt-4 text-base text-text-tertiary">
        Your preferences are saved on this device.
      </p>
    </div>
  );
}
