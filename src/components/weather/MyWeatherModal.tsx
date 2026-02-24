"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { useAppStore, type ThemePreference } from "@/lib/store";
import { MapPinIcon, SearchIcon, SunIcon, MoonIcon } from "@/lib/weather-icons";
import { ActivityIcon } from "@/lib/weather-icons";
import type { WeatherLocation } from "@/lib/locations";
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
import { cn } from "@/lib/utils";

const POPULAR_SLUGS = [
  "harare", "bulawayo", "mutare", "gweru", "masvingo",
  "victoria-falls", "kariba", "marondera", "chinhoyi", "kwekwe",
];

// Tag labels — fetched from API when available, with inline fallbacks.
// These are display labels only; not structural data.
const DEFAULT_TAG_LABELS: Record<string, string> = {
  city: "Cities", farming: "Farming", mining: "Mining", tourism: "Tourism",
  "national-park": "National Parks", education: "Education", border: "Border", travel: "Travel",
};

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
function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function MyWeatherModal() {
  const closeMyWeather = useAppStore((s) => s.closeMyWeather);
  const myWeatherOpen = useAppStore((s) => s.myWeatherOpen);
  const completeOnboarding = useAppStore((s) => s.completeOnboarding);
  const setSelectedLocation = useAppStore((s) => s.setSelectedLocation);
  const router = useRouter();
  const pathname = usePathname();

  // Track pending location selection (deferred navigation)
  const currentSlug = pathname?.replace("/", "") || "harare";
  const [pendingSlug, setPendingSlug] = useState(currentSlug);
  const [activeTab, setActiveTab] = useState("location");

  const [allActivities, setAllActivities] = useState<Activity[]>(ACTIVITIES);
  const [activityCategories, setActivityCategories] = useState<ActivityCategoryDoc[]>(CATEGORIES);
  const [tagLabels, setTagLabels] = useState<Record<string, string>>(DEFAULT_TAG_LABELS);
  const [tagOrder, setTagOrder] = useState<string[]>(Object.keys(DEFAULT_TAG_LABELS));

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
    // Fetch activities, categories, and tags (but NOT all locations)
    Promise.all([
      fetch("/api/py/activities")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => { if (data?.activities?.length) setAllActivities(data.activities); })
        .catch(() => {}),
      fetch("/api/py/activities?mode=categories")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => { if (data?.categories?.length) setActivityCategories(data.categories); })
        .catch(() => {}),
      fetch("/api/py/tags")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data?.tags?.length) {
            const labels: Record<string, string> = {};
            const order: string[] = [];
            for (const t of data.tags) {
              labels[t.slug] = t.label;
              order.push(t.slug);
            }
            setTagLabels(labels);
            setTagOrder(order);
          }
        })
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
      setActiveTab("location");
    } else {
      handleDone();
    }
  };

  /** When user selects a location, auto-advance to activities tab */
  const handleSelectLocation = useCallback((slug: string) => {
    setPendingSlug(slug);
    // Brief delay so user sees their selection highlighted before switching
    setTimeout(() => setActiveTab("activities"), 250);
  }, []);

  /** When a location is detected/created via geolocation, set as pending and
   *  advance to Activities tab — same deferred navigation as manual selection. */
  const handleGeoLocationResolved = useCallback((slug: string) => {
    setPendingSlug(slug);
    setTimeout(() => setActiveTab("activities"), 250);
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

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="shrink-0">
            <TabsTrigger value="location">Location</TabsTrigger>
            <TabsTrigger value="activities">
              Activities
            </TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="location">
            <LocationTab
              pendingSlug={pendingSlug}
              onSelectLocation={handleSelectLocation}
              onGeoLocationResolved={handleGeoLocationResolved}
              tagLabels={tagLabels}
              tagOrder={tagOrder}
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

// ── Location Tab ───────────────────────────────────────────────────────────

function LocationTab({
  pendingSlug,
  onSelectLocation,
  onGeoLocationResolved,
  tagLabels,
  tagOrder,
}: {
  pendingSlug: string;
  onSelectLocation: (slug: string) => void;
  onGeoLocationResolved: (slug: string) => void;
  tagLabels: Record<string, string>;
  tagOrder: string[];
}) {
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [geoState, setGeoState] = useState<GeoResult | null>(null);
  const [geoLoading, setGeoLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Search-driven location results
  const [searchResults, setSearchResults] = useState<WeatherLocation[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [popularLocations, setPopularLocations] = useState<WeatherLocation[]>([]);
  const [popularLoading, setPopularLoading] = useState(true);

  const debouncedQuery = useDebounce(query, 250);

  // Focus the search input on mount
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  // Fetch popular locations on mount (small set, not all)
  useEffect(() => {
    const slugParam = POPULAR_SLUGS.join(",");
    fetch(`/api/py/search?q=${encodeURIComponent(slugParam.slice(0, 200))}&limit=10`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.locations?.length) {
          setPopularLocations(data.locations);
        }
      })
      .catch(() => {})
      .finally(() => setPopularLoading(false));
  }, []);

  // Search when the debounced query or active tag changes.
  // Loading state is derived from an in-flight fetch counter to avoid
  // calling setState synchronously inside the effect body.
  const searchGenRef = useRef(0);

  useEffect(() => {
    const q = debouncedQuery.trim();
    if (!q && !activeTag) {
      // Defer to avoid synchronous setState in effect body
      const id = requestAnimationFrame(() => setSearchResults([]));
      return () => cancelAnimationFrame(id);
    }

    const gen = ++searchGenRef.current;
    const controller = new AbortController();
    const url = !q && activeTag
      ? `/api/py/locations?tag=${encodeURIComponent(activeTag)}&limit=50`
      : `/api/py/search?q=${encodeURIComponent(q)}&limit=20`;

    const loadId = requestAnimationFrame(() => {
      if (searchGenRef.current === gen) setSearchLoading(true);
    });

    fetch(url, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (searchGenRef.current === gen) {
          setSearchResults(data?.locations ?? []);
          setSearchLoading(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && searchGenRef.current === gen) {
          setSearchResults([]);
          setSearchLoading(false);
        }
      });
    return () => { controller.abort(); cancelAnimationFrame(loadId); };
  }, [debouncedQuery, activeTag]);

  // Geolocation detection — set pending location and advance to activities
  const handleGeolocate = useCallback(async () => {
    setGeoLoading(true);
    const result = await detectUserLocation();
    setGeoState(result);
    setGeoLoading(false);

    if ((result.status === "success" || result.status === "created") && result.location) {
      onGeoLocationResolved(result.location.slug);
    }
  }, [onGeoLocationResolved]);

  // Determine which locations to display
  const displayedLocations = useMemo(() => {
    if (query.trim() || activeTag) return searchResults;
    return popularLocations;
  }, [query, activeTag, searchResults, popularLocations]);

  const loading = query.trim() || activeTag ? searchLoading : popularLoading;

  return (
    <div className="flex flex-col gap-1">
      {/* Search input */}
      <div className="px-4 pt-3 pb-2">
        <div className="relative">
          <Input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveTag(null);
            }}
            placeholder="Search locations..."
            className="pl-9"
            aria-label="Search locations"
          />
          <SearchIcon size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
        </div>
      </div>

      {/* Geolocation button */}
      <div className="px-4">
        <Button
          variant="ghost"
          onClick={handleGeolocate}
          disabled={geoLoading}
          className="flex min-h-[44px] w-full items-center justify-start gap-3 text-primary"
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
        </Button>
        {geoState?.status === "denied" && (
          <p className="px-3 pb-1 text-sm text-text-tertiary">
            Location access denied. Enable it in your browser settings.
          </p>
        )}
        {geoState?.status === "outside-supported" && (
          <p className="px-3 pb-1 text-sm text-text-tertiary">
            Your area isn&apos;t supported yet. Select a location below.
          </p>
        )}
        {geoState?.status === "created" && (
          <p className="px-3 pb-1 text-sm text-severity-low">
            New location added! Weather data is loading.
          </p>
        )}
      </div>

      {/* Tag filter pills */}
      {!query && (
        <ToggleGroup
          type="single"
          value={activeTag ?? ""}
          onValueChange={(val) => setActiveTag(val || null)}
          className="flex flex-wrap gap-1.5 px-4 py-2"
          aria-label="Filter locations by category"
        >
          {tagOrder.map((tag) => (
            <ToggleGroupItem key={tag} value={tag} className="min-h-[44px]">
              {tagLabels[tag] ?? tag}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}

      {/* Location list — no nested scroll, uses tab content scroll */}
      <ul role="listbox" aria-label="Available locations" aria-multiselectable="false" className="px-2 pb-2">
        {loading && displayedLocations.length === 0 && (
          Array.from({ length: 5 }).map((_, i) => (
            <li key={i} className="px-3 py-2" aria-hidden="true">
              <div className="h-10 animate-pulse rounded-[var(--radius-input)] bg-surface-base" />
            </li>
          ))
        )}
        {!loading && displayedLocations.length === 0 && (
          <li className="px-3 py-4 text-center text-sm text-text-tertiary">
            {query ? `No locations found for "${query}"` : "No locations available"}
          </li>
        )}
        {displayedLocations.map((loc) => {
          const isSelected = loc.slug === pendingSlug;
          // Country/province are automatic context, not selectable options
          const countryCode = (loc.country ?? "ZW").toUpperCase();
          const contextLabel = countryCode !== "ZW"
            ? `${loc.province}, ${countryCode}`
            : loc.province;
          return (
            <li key={loc.slug} role="option" aria-selected={isSelected}>
              <button
                onClick={() => onSelectLocation(loc.slug)}
                className={`flex w-full min-h-[44px] items-center gap-3 rounded-[var(--radius-input)] px-3 py-2 text-sm transition-all hover:bg-surface-base focus-visible:outline-2 focus-visible:outline-primary ${
                  isSelected
                    ? "bg-primary/10 text-primary font-semibold"
                    : "text-text-primary"
                }`}
                type="button"
              >
                <MapPinIcon
                  size={14}
                  className={isSelected ? "text-primary" : "text-text-tertiary"}
                />
                <div className="min-w-0 flex-1 text-left">
                  <span className="block truncate">{loc.name}</span>
                  <span className="block text-xs text-text-tertiary truncate">{contextLabel}</span>
                </div>
                {isSelected && (
                  <span className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary animate-[scale-in_200ms_ease-out]" aria-hidden="true">
                    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" className="stroke-primary-foreground" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {/* Community location stat — prominent to inspire contributions */}
      <LocationCountCard />
    </div>
  );
}

// ── Location Count Card ─────────────────────────────────────────────────────

function LocationCountCard() {
  const closeMyWeather = useAppStore((s) => s.closeMyWeather);
  const [stats, setStats] = useState<{ totalLocations: number; totalCountries: number } | null>(null);

  useEffect(() => {
    fetch("/api/py/locations?mode=stats")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.totalLocations) setStats(data);
      })
      .catch(() => {});
  }, []);

  const summary = stats
    ? `${stats.totalLocations} locations across ${stats.totalCountries} ${stats.totalCountries === 1 ? "country" : "countries"}`
    : "Loading locations...";

  return (
    <div className="mx-4 mb-3">
      <div className="flex items-center justify-between gap-2 rounded-[var(--radius-input)] border border-primary/10 bg-primary/5 px-3 py-2">
        <div className="flex items-center gap-2">
          <MapPinIcon size={14} className="shrink-0 text-primary" aria-hidden="true" />
          <span className="text-sm font-medium text-text-primary">{summary}</span>
        </div>
        <Link
          href="/explore"
          prefetch={false}
          onClick={closeMyWeather}
          className="shrink-0 text-xs text-primary underline-offset-2 hover:underline"
        >
          Explore all
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
        <h4 className="text-sm font-semibold text-text-primary">
          Select activities for personalised weather insights
          {selectedActivities.length > 0 && (
            <span className="ml-2 text-xs font-normal text-text-tertiary">
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
            "shrink-0 rounded-[var(--radius-badge)] px-4 py-2 min-h-[44px] text-sm font-medium transition-colors",
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
                "shrink-0 rounded-[var(--radius-badge)] px-4 py-2 min-h-[44px] text-sm font-medium transition-colors",
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
                <span className={`text-sm font-medium ${isSelected ? style.text : "text-text-secondary"}`}>
                  {activity.label}
                </span>
              </button>
            );
          })}
        </div>

        {filteredActivities.length === 0 && activityQuery && (
          <p className="py-8 text-center text-sm text-text-tertiary">
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
      <h4 className="mb-3 text-sm font-semibold text-text-primary">Appearance</h4>
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
              <p className={`text-sm font-medium ${theme === option.value ? "text-primary" : "text-text-primary"}`}>
                {option.label}
              </p>
              <p className="text-xs text-text-tertiary">{option.description}</p>
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

      <p className="mt-4 text-xs text-text-tertiary">
        Your preferences are saved on this device.
      </p>
    </div>
  );
}
