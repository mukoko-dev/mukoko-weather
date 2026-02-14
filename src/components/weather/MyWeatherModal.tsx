"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAppStore, type ThemePreference } from "@/lib/store";
import { MapPinIcon, SearchIcon, SunIcon, MoonIcon } from "@/lib/weather-icons";
import { ActivityIcon } from "@/lib/weather-icons";
import {
  LOCATIONS,
  searchLocations,
  getLocationsByTag,
  TAG_LABELS,
  type LocationTag,
} from "@/lib/locations";
import { detectUserLocation, type GeoResult } from "@/lib/geolocation";
import {
  ACTIVITIES,
  ACTIVITY_CATEGORIES,
  CATEGORY_STYLES,
  searchActivities,
  type ActivityCategory,
} from "@/lib/activities";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

const POPULAR_SLUGS = [
  "harare", "bulawayo", "mutare", "gweru", "masvingo",
  "victoria-falls", "kariba", "marondera", "chinhoyi", "kwekwe",
];

const TAG_ORDER: LocationTag[] = [
  "city", "farming", "mining", "tourism", "national-park", "education", "border", "travel",
];

function MonitorIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <line x1="8" x2="16" y1="21" y2="21" />
      <line x1="12" x2="12" y1="17" y2="21" />
    </svg>
  );
}

/** Get the category style or fall back to casual/primary */
function getCategoryStyle(category: string) {
  return CATEGORY_STYLES[category] ?? CATEGORY_STYLES.casual;
}

export function MyWeatherModal() {
  const closeMyWeather = useAppStore((s) => s.closeMyWeather);
  const myWeatherOpen = useAppStore((s) => s.myWeatherOpen);
  const router = useRouter();
  const pathname = usePathname();

  // Track pending location selection (deferred navigation)
  const currentSlug = pathname?.replace("/", "") || "harare";
  const [pendingSlug, setPendingSlug] = useState(currentSlug);

  // Reset pending slug when modal opens with a new URL
  useEffect(() => {
    if (myWeatherOpen) setPendingSlug(currentSlug);
  }, [myWeatherOpen, currentSlug]);

  const handleDone = () => {
    closeMyWeather();
    if (pendingSlug !== currentSlug) {
      router.push(`/${pendingSlug}`);
    }
  };

  const locationChanged = pendingSlug !== currentSlug;

  return (
    <Dialog open={myWeatherOpen} onOpenChange={(open) => { if (!open) handleDone(); }}>
      <DialogContent className="flex max-h-[90vh] flex-col p-0 sm:max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <DialogTitle>My Weather</DialogTitle>
          <Button size="sm" onClick={handleDone}>
            {locationChanged ? "Apply" : "Done"}
          </Button>
        </div>

        {/* Tabs */}
        <Tabs defaultValue="weather" className="flex flex-1 flex-col overflow-hidden">
          <TabsList>
            <TabsTrigger value="weather">My Weather</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="weather">
            <WeatherTab pendingSlug={pendingSlug} onSelectLocation={setPendingSlug} />
          </TabsContent>

          <TabsContent value="settings">
            <SettingsTab />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// ── Unified Weather Tab (Location + Activities) ─────────────────────────────

function WeatherTab({ pendingSlug, onSelectLocation }: { pendingSlug: string; onSelectLocation: (slug: string) => void }) {
  const selectedActivities = useAppStore((s) => s.selectedActivities);
  const toggleActivity = useAppStore((s) => s.toggleActivity);
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<LocationTag | null>(null);
  const [geoState, setGeoState] = useState<GeoResult | null>(null);
  const [geoLoading, setGeoLoading] = useState(false);
  const [activeCategory, setActiveCategory] = useState<ActivityCategory | "all">("all");
  const [activityQuery, setActivityQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const activitiesRef = useRef<HTMLDivElement>(null);

  // Focus the search input on mount
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  // Geolocation detection
  const handleGeolocate = useCallback(async () => {
    setGeoLoading(true);
    const result = await detectUserLocation();
    setGeoState(result);
    setGeoLoading(false);

    if (result.status === "success" && result.location) {
      onSelectLocation(result.location.slug);
      // Scroll to activities so user can pick those too
      setTimeout(() => activitiesRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    }
  }, [onSelectLocation]);

  // Filtered locations
  const displayedLocations = useMemo(() => {
    if (query.length > 0) return searchLocations(query);
    if (activeTag) return getLocationsByTag(activeTag);
    return LOCATIONS.filter((l) => POPULAR_SLUGS.includes(l.slug));
  }, [query, activeTag]);

  const handleSelect = (slug: string) => {
    onSelectLocation(slug);
    // Scroll to activities so user can pick those too
    setTimeout(() => activitiesRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
  };

  // Filtered activities
  const filteredActivities = useMemo(() => {
    let items = activityQuery ? searchActivities(activityQuery) : ACTIVITIES;
    if (activeCategory !== "all") {
      items = items.filter((a) => a.category === activeCategory);
    }
    return items;
  }, [activityQuery, activeCategory]);

  return (
    <div>
      {/* ── Location Section ─────────────────────────────────────── */}
      <div className="px-4 pt-3 pb-1">
        <h4 className="text-sm font-semibold text-text-primary">Location</h4>
      </div>

      {/* Search input */}
      <div className="border-b border-text-tertiary/10 p-3 pt-2">
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
      <div className="border-b border-text-tertiary/10 px-3 py-2">
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
        {geoState?.status === "outside-zw" && (
          <p className="px-3 pb-1 text-sm text-text-tertiary">
            You appear to be outside Zimbabwe. Select a location below.
          </p>
        )}
      </div>

      {/* Tag filter pills */}
      {!query && (
        <div role="group" aria-label="Filter locations by category" className="flex flex-wrap gap-1.5 border-b border-text-tertiary/10 px-3 py-2">
          {TAG_ORDER.map((tag) => (
            <Button
              key={tag}
              variant={activeTag === tag ? "default" : "secondary"}
              size="sm"
              onClick={() => setActiveTag(activeTag === tag ? null : tag)}
              aria-pressed={activeTag === tag}
              className="min-h-[44px]"
            >
              {TAG_LABELS[tag]}
            </Button>
          ))}
        </div>
      )}

      {/* Location list */}
      <ul role="listbox" aria-label="Available locations" className="max-h-48 overflow-y-auto p-2">
        {displayedLocations.length === 0 && (
          <li className="px-3 py-4 text-center text-sm text-text-tertiary">
            No locations found for &quot;{query}&quot;
          </li>
        )}
        {displayedLocations.map((loc) => (
          <li key={loc.slug} role="option" aria-selected={loc.slug === pendingSlug}>
            <button
              onClick={() => handleSelect(loc.slug)}
              className={`flex w-full min-h-[44px] items-center gap-3 rounded-[var(--radius-input)] px-3 py-2 text-sm transition-colors hover:bg-surface-base focus-visible:outline-2 focus-visible:outline-primary ${
                loc.slug === pendingSlug
                  ? "bg-primary/10 text-primary font-semibold"
                  : "text-text-primary"
              }`}
              type="button"
            >
              <MapPinIcon
                size={14}
                className={loc.slug === pendingSlug ? "text-primary" : "text-text-tertiary"}
              />
              <div className="flex flex-col items-start">
                <span>{loc.name}</span>
                <span className="text-sm text-text-tertiary">{loc.province}</span>
              </div>
              <div className="ml-auto flex gap-1">
                {loc.tags.slice(0, 2).map((tag) => (
                  <Badge key={tag} variant="secondary" className="px-1.5 py-0.5">
                    {tag}
                  </Badge>
                ))}
              </div>
            </button>
          </li>
        ))}
      </ul>

      {/* Location count */}
      <div className="px-3 py-2">
        <p className="text-xs text-text-tertiary">
          {LOCATIONS.length} locations across Zimbabwe
        </p>
      </div>

      {/* ── Activities Section ───────────────────────────────────── */}
      <div ref={activitiesRef} className="border-t border-border px-4 pt-3 pb-1">
        <h4 className="text-sm font-semibold text-text-primary">
          Activities
          {selectedActivities.length > 0 && (
            <span className="ml-2 text-xs font-normal text-text-tertiary">
              {selectedActivities.length} selected
            </span>
          )}
        </h4>
        <p className="mt-0.5 text-xs text-text-tertiary">
          Select activities for personalised weather insights
        </p>
      </div>

      {/* Category filter pills */}
      <div className="flex gap-2 overflow-x-auto px-4 pt-2 pb-2 scrollbar-hide" role="group" aria-label="Activity categories">
        <CategoryTab
          label="All"
          categoryId="all"
          active={activeCategory === "all"}
          onClick={() => setActiveCategory("all")}
        />
        {ACTIVITY_CATEGORIES.map((cat) => (
          <CategoryTab
            key={cat.id}
            label={cat.label}
            categoryId={cat.id}
            active={activeCategory === cat.id}
            onClick={() => setActiveCategory(cat.id)}
          />
        ))}
      </div>

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
                className={`relative flex min-h-[88px] flex-col items-center justify-center gap-2 rounded-[var(--radius-card)] border-2 p-3 transition-colors ${
                  isSelected
                    ? `${style.border} ${style.bg}`
                    : "border-transparent bg-surface-base hover:border-text-tertiary/30"
                }`}
              >
                {isSelected && (
                  <span className={`absolute top-1.5 right-1.5 flex h-5 w-5 items-center justify-center rounded-full ${style.badge}`} aria-hidden="true">
                    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </span>
                )}
                <ActivityIcon
                  activity={activity.id}
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

        {filteredActivities.length === 0 && (
          <p className="py-8 text-center text-sm text-text-tertiary">
            No activities found for &ldquo;{activityQuery}&rdquo;
          </p>
        )}
      </div>
    </div>
  );
}

function CategoryTab({
  label,
  categoryId,
  active,
  onClick,
}: {
  label: string;
  categoryId: string;
  active: boolean;
  onClick: () => void;
}) {
  const style = categoryId === "all" ? null : getCategoryStyle(categoryId);

  return (
    <button
      aria-pressed={active}
      onClick={onClick}
      className={`shrink-0 rounded-[var(--radius-badge)] px-3 py-1.5 text-sm font-medium transition-colors ${
        active
          ? style ? `${style.badge}` : "bg-primary text-primary-foreground"
          : "bg-surface-base text-text-secondary hover:text-text-primary"
      }`}
    >
      {label}
    </button>
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
            className={`flex w-full min-h-[44px] items-center gap-3 rounded-[var(--radius-card)] border-2 px-4 py-3 text-left transition-colors ${
              theme === option.value
                ? "border-primary bg-primary/5"
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
              <span className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-primary" aria-hidden="true">
                <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--color-primary-foreground)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
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
