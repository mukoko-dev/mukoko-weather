"use client";

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { ChartErrorBoundary } from "@/components/weather/ChartErrorBoundary";
import { LazySection } from "@/components/weather/LazySection";
import { StatCard } from "@/components/weather/StatCard";
import { TemperatureTrendChart } from "@/components/weather/charts/TemperatureTrendChart";
import { PrecipitationChart } from "@/components/weather/charts/PrecipitationChart";
import { UVCloudChart } from "@/components/weather/charts/UVCloudChart";
import { WindSpeedChart } from "@/components/weather/charts/WindSpeedChart";
import { PressureChart } from "@/components/weather/charts/PressureChart";
import { HumidityChart } from "@/components/weather/charts/HumidityChart";
import { DaylightChart } from "@/components/weather/charts/DaylightChart";
import { DewPointChart } from "@/components/weather/charts/DewPointChart";
import { HeatStressChart } from "@/components/weather/charts/HeatStressChart";
import { VisibilityChart } from "@/components/weather/charts/VisibilityChart";
import { ThunderstormChart } from "@/components/weather/charts/ThunderstormChart";
import { GDDChart } from "@/components/weather/charts/GDDChart";
import { ChartSkeleton } from "@/components/ui/skeleton";
import { HistoryAnalysis } from "@/components/weather/HistoryAnalysis";
import type { WeatherLocation } from "@/lib/locations";
import { useAppStore } from "@/lib/store";
import { weatherCodeToInfo, windDirection, uvLevel } from "@/lib/weather";
import type { WeatherInsights } from "@/lib/weather";
import type { WeatherHistoryDoc } from "@/lib/db";
import type { ActivityCategory } from "@/lib/activities";
import type { ActivityCategoryDoc } from "@/lib/db";
import { CATEGORIES } from "@/lib/seed-categories";
import {
  heatStressLevel,
  uvConcernLabel,
} from "@/components/weather/ActivityInsights";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DayRange = 7 | 14 | 30 | 90 | 180 | 365;
type ViewTab = "weather" | "insights";

interface HistoryRecord {
  date: string;
  tempHigh: number;
  tempLow: number;
  feelsLikeHigh: number;
  feelsLikeLow: number;
  precipitation: number;
  rainProbability: number;
  humidity: number;
  cloudCover: number;
  pressure: number;
  uvIndex: number;
  windSpeed: number;
  windGusts: number;
  windDirection: number;
  windDirectionLabel: string;
  sunrise: string;
  sunset: string;
  daylightHours: number;
  weatherCode: number;
  condition: string;
}

/** Flattened insights record for charting */
export interface InsightsRecord {
  date: string;
  dewPoint: number | null;
  heatStress: number | null;
  thunderstorm: number | null;
  visibility: number | null;
  uvConcern: number | null;
  gddMaize: number | null;
  gddSorghum: number | null;
  gddPotato: number | null;
  evapotranspiration: number | null;
  moonPhase: number | null;
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

function parseSunTime(iso: string): { hours: number; minutes: number } {
  const d = new Date(iso);
  return { hours: d.getHours(), minutes: d.getMinutes() };
}

function daylightFromSunTimes(sunrise: string, sunset: string): number {
  const rise = new Date(sunrise).getTime();
  const set = new Date(sunset).getTime();
  return Math.round(((set - rise) / (1000 * 60 * 60)) * 10) / 10;
}

function formatSunTime(iso: string): string {
  const { hours, minutes } = parseSunTime(iso);
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

export function transformHistory(docs: WeatherHistoryDoc[]): HistoryRecord[] {
  return docs
    .map((doc) => {
      const daily = doc.daily;
      const current = doc.current;

      const sunriseRaw = daily?.sunrise?.[0] ?? "";
      const sunsetRaw = daily?.sunset?.[0] ?? "";

      return {
        date: doc.date,
        tempHigh: daily?.temperature_2m_max?.[0] != null
          ? Math.round(daily.temperature_2m_max[0])
          : Math.round(current.temperature_2m),
        tempLow: daily?.temperature_2m_min?.[0] != null
          ? Math.round(daily.temperature_2m_min[0])
          : Math.round(current.temperature_2m - 5),
        feelsLikeHigh: daily?.apparent_temperature_max?.[0] != null
          ? Math.round(daily.apparent_temperature_max[0])
          : Math.round(current.apparent_temperature),
        feelsLikeLow: daily?.apparent_temperature_min?.[0] != null
          ? Math.round(daily.apparent_temperature_min[0])
          : Math.round(current.apparent_temperature - 5),
        precipitation: daily?.precipitation_sum?.[0] ?? current.precipitation,
        rainProbability: daily?.precipitation_probability_max?.[0] ?? 0,
        humidity: current.relative_humidity_2m,
        cloudCover: current.cloud_cover,
        pressure: Math.round(current.surface_pressure),
        uvIndex: daily?.uv_index_max?.[0] ?? current.uv_index,
        windSpeed: Math.round(current.wind_speed_10m),
        windGusts: daily?.wind_gusts_10m_max?.[0] != null
          ? Math.round(daily.wind_gusts_10m_max[0])
          : Math.round(current.wind_gusts_10m),
        windDirection: current.wind_direction_10m,
        windDirectionLabel: windDirection(current.wind_direction_10m),
        sunrise: sunriseRaw ? formatSunTime(sunriseRaw) : "--:--",
        sunset: sunsetRaw ? formatSunTime(sunsetRaw) : "--:--",
        daylightHours: sunriseRaw && sunsetRaw
          ? daylightFromSunTimes(sunriseRaw, sunsetRaw)
          : 0,
        weatherCode: current.weather_code,
        condition: weatherCodeToInfo(current.weather_code).label,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function transformInsights(docs: WeatherHistoryDoc[]): InsightsRecord[] {
  return docs
    .filter((d) => d.insights != null)
    .map((doc) => {
      const ins = doc.insights as WeatherInsights;
      return {
        date: doc.date,
        dewPoint: ins.dewPoint ?? null,
        heatStress: ins.heatStressIndex ?? null,
        thunderstorm: ins.thunderstormProbability ?? null,
        visibility: ins.visibility ?? null,
        uvConcern: ins.uvHealthConcern ?? null,
        gddMaize: ins.gdd10To30 ?? null,
        gddSorghum: ins.gdd08To30 ?? null,
        gddPotato: ins.gdd03To25 ?? null,
        evapotranspiration: ins.evapotranspiration ?? null,
        moonPhase: ins.moonPhase ?? null,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

const DAY_OPTIONS: { value: DayRange; label: string }[] = [
  { value: 7, label: "7 days" },
  { value: 14, label: "14 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "3 months" },
  { value: 180, label: "6 months" },
  { value: 365, label: "1 year" },
];

/** Category style shape */
interface CategoryStyleShape {
  bg: string;
  border: string;
  text: string;
  badge: string;
}

function avg(arr: number[]): number {
  return arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : 0;
}

function avgFloat(arr: number[]): number {
  return arr.length ? Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10 : 0;
}

function sum(arr: number[]): number {
  return Math.round(arr.reduce((s, v) => s + v, 0) * 10) / 10;
}

function defined<T>(v: T | null | undefined): v is T {
  return v != null;
}

// ---------------------------------------------------------------------------
// Suitability gauge card
// ---------------------------------------------------------------------------

function SuitabilityGauge({
  label,
  level,
  levelLabel,
  colorClass,
  bgClass,
  detail,
  icon,
}: {
  label: string;
  level: "excellent" | "good" | "fair" | "poor";
  levelLabel: string;
  colorClass: string;
  bgClass: string;
  detail: string;
  icon: string;
}) {
  const pct = level === "excellent" ? 100 : level === "good" ? 75 : level === "fair" ? 50 : 25;
  return (
    <div className="rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm" role="group" aria-label={label}>
      <div className="flex items-center gap-2">
        <span className="text-lg" aria-hidden="true">{icon}</span>
        <p className="text-base font-semibold text-text-primary">{label}</p>
        <span className={`ml-auto rounded-[var(--radius-badge)] px-2 py-0.5 text-base font-bold ${bgClass} ${colorClass}`}>
          {levelLabel}
        </span>
      </div>
      {/* Gauge bar */}
      <div className="mt-3 h-2 w-full rounded-full bg-surface-dim" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${label}: ${levelLabel}`}>
        <div className={`h-full rounded-full transition-all ${bgClass.replace("/10", "")}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-base text-text-secondary">{detail}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compute suitability from aggregated insights
// ---------------------------------------------------------------------------

interface CategorySuitability {
  label: string;
  level: "excellent" | "good" | "fair" | "poor";
  levelLabel: string;
  colorClass: string;
  bgClass: string;
  detail: string;
  icon: string;
  category: string;
}

export function computeCategorySuitability(
  insightsRecords: InsightsRecord[],
): CategorySuitability[] {
  if (insightsRecords.length === 0) return [];

  const dewPoints = insightsRecords.map((r) => r.dewPoint).filter(defined);
  const heatStresses = insightsRecords.map((r) => r.heatStress).filter(defined);
  const thunderstorms = insightsRecords.map((r) => r.thunderstorm).filter(defined);
  const visibilities = insightsRecords.map((r) => r.visibility).filter(defined);
  const uvConcerns = insightsRecords.map((r) => r.uvConcern).filter(defined);
  const gddMaize = insightsRecords.map((r) => r.gddMaize).filter(defined);

  const results: CategorySuitability[] = [];

  // Farming
  if (dewPoints.length > 0 || gddMaize.length > 0) {
    const avgDew = dewPoints.length > 0 ? avgFloat(dewPoints) : 15;
    const avgGdd = gddMaize.length > 0 ? avgFloat(gddMaize) : 0;
    let level: CategorySuitability["level"] = "good";
    let detail = `Avg dew point: ${avgDew}°C`;
    if (avgGdd > 0) detail += ` | Avg GDD: ${avgGdd}`;
    if (avgDew > 20) { level = "fair"; detail = "High avg dew point — crop disease risk elevated"; }
    else if (avgDew < 5) { level = "poor"; detail = "Low avg dew point — cold, dry air stress for crops"; }
    else if (avgGdd > 15) { level = "excellent"; detail = `Strong growth period (avg GDD: ${avgGdd})`; }
    const { colorClass, bgClass, label: lvl } = suitabilityColors(level);
    results.push({ label: "Farming", level, levelLabel: lvl, colorClass, bgClass, detail, icon: "🌱", category: "farming" });
  }

  // Mining
  if (heatStresses.length > 0 || thunderstorms.length > 0) {
    const avgHeat = heatStresses.length > 0 ? avgFloat(heatStresses) : 20;
    const avgStorm = thunderstorms.length > 0 ? avgFloat(thunderstorms) : 0;
    let level: CategorySuitability["level"] = "good";
    let detail = "Safe conditions overall";
    if (avgHeat >= 28) { level = "poor"; detail = `Severe heat stress (avg: ${avgHeat})`; }
    else if (avgStorm > 40) { level = "poor"; detail = `High storm risk (avg: ${Math.round(avgStorm)}%)`; }
    else if (avgHeat >= 24 || avgStorm > 20) { level = "fair"; detail = `Moderate risk — heat: ${avgHeat}, storm: ${Math.round(avgStorm)}%`; }
    else { level = "good"; detail = `Low risk — heat: ${avgHeat}, storm: ${Math.round(avgStorm)}%`; }
    const { colorClass, bgClass, label: lvl } = suitabilityColors(level);
    results.push({ label: "Mining", level, levelLabel: lvl, colorClass, bgClass, detail, icon: "⛏️", category: "mining" });
  }

  // Sports
  if (heatStresses.length > 0 || uvConcerns.length > 0) {
    const avgHeat = heatStresses.length > 0 ? avgFloat(heatStresses) : 20;
    const avgUv = uvConcerns.length > 0 ? avgFloat(uvConcerns) : 3;
    let level: CategorySuitability["level"] = "excellent";
    let detail = "Great conditions for outdoor exercise";
    if (avgHeat >= 28) { level = "poor"; detail = "Too hot for outdoor sports"; }
    else if (avgUv > 7) { level = "fair"; detail = `High UV exposure (avg: ${avgUv}) — sun protection needed`; }
    else if (avgHeat >= 24) { level = "fair"; detail = "Warm — hydration breaks recommended"; }
    const { colorClass, bgClass, label: lvl } = suitabilityColors(level);
    results.push({ label: "Sports", level, levelLabel: lvl, colorClass, bgClass, detail, icon: "🏃", category: "sports" });
  }

  // Travel
  if (visibilities.length > 0 || thunderstorms.length > 0) {
    const avgVis = visibilities.length > 0 ? avgFloat(visibilities) : 10;
    const avgStorm = thunderstorms.length > 0 ? avgFloat(thunderstorms) : 0;
    let level: CategorySuitability["level"] = "good";
    let detail = `Clear conditions — avg visibility: ${avgVis} km`;
    if (avgVis < 1) { level = "poor"; detail = "Very poor visibility — travel not recommended"; }
    else if (avgStorm > 40) { level = "poor"; detail = `High storm risk for travel (avg: ${Math.round(avgStorm)}%)`; }
    else if (avgVis < 5 || avgStorm > 20) { level = "fair"; detail = `Moderate risk — vis: ${avgVis} km, storm: ${Math.round(avgStorm)}%`; }
    const { colorClass, bgClass, label: lvl } = suitabilityColors(level);
    results.push({ label: "Travel", level, levelLabel: lvl, colorClass, bgClass, detail, icon: "🚗", category: "travel" });
  }

  // Tourism
  if (uvConcerns.length > 0 || visibilities.length > 0) {
    const avgUv = uvConcerns.length > 0 ? avgFloat(uvConcerns) : 3;
    const avgVis = visibilities.length > 0 ? avgFloat(visibilities) : 10;
    let level: CategorySuitability["level"] = "good";
    let detail = "Good conditions for outdoor activities";
    if (avgUv > 7) { level = "fair"; detail = "Very high UV — seek shade during midday"; }
    else if (avgVis < 5) { level = "fair"; detail = "Limited visibility may affect game viewing"; }
    else { level = "good"; detail = `Good visibility (${avgVis} km) and moderate UV`; }
    const { colorClass, bgClass, label: lvl } = suitabilityColors(level);
    results.push({ label: "Tourism", level, levelLabel: lvl, colorClass, bgClass, detail, icon: "🦁", category: "tourism" });
  }

  // Casual
  if (thunderstorms.length > 0 || heatStresses.length > 0) {
    const avgStorm = thunderstorms.length > 0 ? avgFloat(thunderstorms) : 0;
    const avgHeat = heatStresses.length > 0 ? avgFloat(heatStresses) : 20;
    let level: CategorySuitability["level"] = "excellent";
    let detail = "Perfect for outdoor plans";
    if (avgStorm > 40) { level = "poor"; detail = "Thunderstorm risk — indoor activities recommended"; }
    else if (avgHeat >= 28) { level = "fair"; detail = "Very warm — limit time outdoors"; }
    else if (avgStorm > 20 || avgHeat >= 24) { level = "fair"; detail = "Moderate conditions — check forecast"; }
    const { colorClass, bgClass, label: lvl } = suitabilityColors(level);
    results.push({ label: "Casual", level, levelLabel: lvl, colorClass, bgClass, detail, icon: "☀️", category: "casual" });
  }

  return results;
}

export function suitabilityColors(level: "excellent" | "good" | "fair" | "poor") {
  switch (level) {
    case "excellent": return { colorClass: "text-severity-low", bgClass: "bg-severity-low/10", label: "Excellent" };
    case "good": return { colorClass: "text-severity-low", bgClass: "bg-severity-low/10", label: "Good" };
    case "fair": return { colorClass: "text-severity-moderate", bgClass: "bg-severity-moderate/10", label: "Fair" };
    case "poor": return { colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10", label: "Poor" };
  }
}

// ── Main component ──────────────────────────────────────────────────────────

export function HistoryDashboard() {
  const globalSlug = useAppStore((s) => s.selectedLocation);
  const [query, setQuery] = useState("");
  const [selectedLocation, setSelectedLocation] = useState<WeatherLocation | null>(null);
  const [days, setDays] = useState<DayRange>(30);
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [insightsRecords, setInsightsRecords] = useState<InsightsRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [fetched, setFetched] = useState(false);
  const [visibleRowCount, setVisibleRowCount] = useState(50);
  const [activeTab, setActiveTab] = useState<ViewTab>("weather");
  const [categoryFilter, setCategoryFilter] = useState<ActivityCategory | "all">("all");
  const tableEndRef = useRef<HTMLDivElement>(null);
  // Search-driven location results (replaces loading all locations)
  const [searchResults, setSearchResults] = useState<WeatherLocation[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  // Seed with static CATEGORIES for instant filter rendering, then upgrade from MongoDB.
  const [activityCategories, setActivityCategories] = useState<ActivityCategoryDoc[]>(CATEGORIES);
  const didAutoSelect = useRef(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Build category filter options and styles from API data
  const categoryFilterOptions = useMemo(() => {
    const opts: { id: ActivityCategory | "all"; label: string }[] = [
      { id: "all", label: "All Data" },
    ];
    for (const cat of activityCategories) {
      opts.push({ id: cat.id as ActivityCategory, label: cat.label });
    }
    return opts;
  }, [activityCategories]);

  const categoryStyles = useMemo(() => {
    const map: Record<string, CategoryStyleShape> = {};
    for (const cat of activityCategories) {
      if (cat.style) map[cat.id] = cat.style;
    }
    return map;
  }, [activityCategories]);

  // Fetch categories on mount (NOT all locations)
  useEffect(() => {
    fetch("/api/py/activities?mode=categories")
      .then((res) => (res.ok ? res.json() : { categories: [] }))
      .then((data) => { if (data?.categories?.length) setActivityCategories(data.categories); })
      .catch(() => {});
  }, []);

  // Auto-select the global location (from My Weather / last visited location page)
  // by fetching just that one location from the API.
  useEffect(() => {
    if (didAutoSelect.current || !globalSlug) return;
    didAutoSelect.current = true;

    fetch(`/api/py/locations?slug=${encodeURIComponent(globalSlug)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const loc = data?.location;
        if (!loc) return;
        setSelectedLocation(loc);
        setQuery(loc.name);
        setLoading(true);
        setFetched(true);
        return fetch(`/api/py/history?location=${loc.slug}&days=30`);
      })
      .then((res) => {
        if (!res || !res.ok) {
          if (res) return res.json().catch(() => ({ error: "Request failed" })).then((b: { error?: string }) => { throw new Error(b.error || `HTTP ${res.status}`); });
          return;
        }
        return res.json();
      })
      .then((json) => {
        if (!json) return;
        setRecords(transformHistory(json.data));
        setInsightsRecords(transformInsights(json.data));
        setVisibleRowCount(50);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to fetch history");
        setRecords([]);
        setInsightsRecords([]);
      })
      .finally(() => setLoading(false));
  }, [globalSlug]);

  // Debounced search — fetch results from API instead of filtering a full list
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);

    const q = query.trim();
    if (!q || selectedLocation?.name === query) {
      setSearchResults([]);
      return;
    }

    searchTimer.current = setTimeout(() => {
      setSearchLoading(true);
      fetch(`/api/py/search?q=${encodeURIComponent(q)}&limit=10`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => setSearchResults(data?.locations ?? []))
        .catch(() => setSearchResults([]))
        .finally(() => setSearchLoading(false));
    }, 250);

    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [query, selectedLocation?.name]);

  const results = searchResults;

  // ── Infinite scroll for table rows (TikTok-style) ───────────────────────
  useEffect(() => {
    if (records.length <= visibleRowCount) return;
    const sentinel = tableEndRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisibleRowCount((n) => Math.min(n + 50, records.length));
        }
      },
      { rootMargin: "200px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [records.length, visibleRowCount]);

  const fetchHistory = useCallback(
    async (location: WeatherLocation, dayCount: DayRange) => {
      setLoading(true);
      setError(null);
      setFetched(true);
      try {
        const res = await fetch(`/api/py/history?location=${location.slug}&days=${dayCount}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: "Request failed" }));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const json = await res.json();
        setRecords(transformHistory(json.data));
        setInsightsRecords(transformInsights(json.data));
        setVisibleRowCount(50);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to fetch history");
        setRecords([]);
        setInsightsRecords([]);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const handleSelectLocation = (loc: WeatherLocation) => {
    setSelectedLocation(loc);
    setQuery(loc.name);
    setShowDropdown(false);
    fetchHistory(loc, days);
  };

  const handleDaysChange = (newDays: DayRange) => {
    setDays(newDays);
    if (selectedLocation) {
      fetchHistory(selectedLocation, newDays);
    }
  };

  const hasInsights = insightsRecords.length > 0;

  const stats = records.length > 0
    ? {
        avgHigh: avg(records.map((r) => r.tempHigh)),
        avgLow: avg(records.map((r) => r.tempLow)),
        maxTemp: records.reduce((m, r) => Math.max(m, r.tempHigh), -Infinity),
        minTemp: records.reduce((m, r) => Math.min(m, r.tempLow), Infinity),
        avgFeelsHigh: avg(records.map((r) => r.feelsLikeHigh)),
        avgFeelsLow: avg(records.map((r) => r.feelsLikeLow)),
        totalRain: sum(records.map((r) => r.precipitation)),
        rainyDays: records.filter((r) => r.precipitation > 0.1).length,
        avgRainProb: avg(records.map((r) => r.rainProbability)),
        avgHumidity: avg(records.map((r) => r.humidity)),
        avgCloudCover: avg(records.map((r) => r.cloudCover)),
        avgPressure: avg(records.map((r) => r.pressure)),
        avgUv: avg(records.map((r) => Math.round(r.uvIndex))),
        maxUv: Math.round(records.reduce((m, r) => Math.max(m, r.uvIndex), 0) * 10) / 10,
        avgWind: avg(records.map((r) => r.windSpeed)),
        maxGusts: records.reduce((m, r) => Math.max(m, r.windGusts), 0),
        avgDaylight: records[0]?.daylightHours
          ? (Math.round(avg(records.map((r) => Math.round(r.daylightHours * 10))) / 10 * 10) / 10)
          : null,
      }
    : null;

  const insightsStats = hasInsights
    ? {
        avgDewPoint: avgFloat(insightsRecords.map((r) => r.dewPoint).filter(defined)),
        avgHeatStress: avgFloat(insightsRecords.map((r) => r.heatStress).filter(defined)),
        maxHeatStress: insightsRecords.map((r) => r.heatStress).filter(defined).reduce((m, v) => Math.max(m, v), 0),
        avgThunderstorm: avgFloat(insightsRecords.map((r) => r.thunderstorm).filter(defined)),
        maxThunderstorm: insightsRecords.map((r) => r.thunderstorm).filter(defined).reduce((m, v) => Math.max(m, v), 0),
        avgVisibility: avgFloat(insightsRecords.map((r) => r.visibility).filter(defined)),
        avgUvConcern: avgFloat(insightsRecords.map((r) => r.uvConcern).filter(defined)),
        avgGddMaize: avgFloat(insightsRecords.map((r) => r.gddMaize).filter(defined)),
        totalET: sum(insightsRecords.map((r) => r.evapotranspiration).filter(defined)),
        insightDays: insightsRecords.length,
      }
    : null;

  const categorySuitability = useMemo(
    () => computeCategorySuitability(insightsRecords),
    [insightsRecords],
  );

  const filteredSuitability = useMemo(
    () => categoryFilter === "all"
      ? categorySuitability
      : categorySuitability.filter((s) => s.category === categoryFilter),
    [categorySuitability, categoryFilter],
  );

  const chartData = useMemo(() => {
    if (records.length <= 60) return records;
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      const step = Math.ceil(records.length / 60);
      return records.filter((_, i) => i === 0 || i === records.length - 1 || i % step === 0);
    }
    return records;
  }, [records]);

  const insightsChartData = useMemo(() => {
    if (insightsRecords.length <= 60) return insightsRecords;
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      const step = Math.ceil(insightsRecords.length / 60);
      return insightsRecords.filter((_, i) => i === 0 || i === insightsRecords.length - 1 || i % step === 0);
    }
    return insightsRecords;
  }, [insightsRecords]);

  const formatDate = useCallback((dateStr: string) => {
    const d = new Date(dateStr);
    if (days <= 90) {
      return d.toLocaleDateString("en-ZW", { day: "numeric", month: "short" });
    }
    return d.toLocaleDateString("en-ZW", { month: "short", year: "2-digit" });
  }, [days]);

  const formatDateFull = useCallback((dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-ZW", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  }, []);

  const showDots = chartData.length <= 31;

  return (
    <div className="mt-8 space-y-6">
      {/* Search and filters */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="relative flex-1">
          <label htmlFor="history-search" className="mb-1 block text-base font-medium text-text-secondary">Location</label>
          <input
            id="history-search"
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setShowDropdown(true); }}
            onFocus={() => setShowDropdown(true)}
            placeholder="Search locations..."
            className="w-full rounded-[var(--radius-input)] border border-input bg-surface-card px-3 py-2 text-base text-text-primary placeholder:text-text-tertiary outline-none focus-visible:ring-2 focus-visible:ring-primary"
            autoComplete="off"
          />
          {showDropdown && (results.length > 0 || searchLoading) && (
            <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-[var(--radius-input)] border border-input bg-surface-card shadow-md">
              {searchLoading && results.length === 0 && (
                <li className="px-3 py-2 text-base text-text-tertiary">Searching...</li>
              )}
              {results.map((loc) => (
                <li key={loc.slug}>
                  <button type="button" className="w-full px-3 py-2 text-left text-base text-text-primary hover:bg-surface-dim transition-colors" onClick={() => handleSelectLocation(loc)}>
                    <span className="font-medium">{loc.name}</span>
                    <span className="ml-2 text-text-tertiary">{loc.province}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <label htmlFor="history-days" className="mb-1 block text-base font-medium text-text-secondary">Time period</label>
          <select id="history-days" value={days} onChange={(e) => handleDaysChange(Number(e.target.value) as DayRange)} className="rounded-[var(--radius-input)] border border-input bg-surface-card px-3 py-2 text-base text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-primary">
            {DAY_OPTIONS.map((opt) => (<option key={opt.value} value={opt.value}>{opt.label}</option>))}
          </select>
        </div>
      </div>

      {/* Category filter pills */}
      {fetched && !loading && records.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by activity category">
          {categoryFilterOptions.map((opt) => {
            const active = categoryFilter === opt.id;
            const style = opt.id !== "all" ? (categoryStyles[opt.id] ?? null) : null;
            return (
              <button
                key={opt.id}
                onClick={() => setCategoryFilter(opt.id)}
                aria-pressed={active}
                className={`min-h-[48px] rounded-[var(--radius-badge)] px-4 py-2 text-base font-medium transition-colors ${
                  active
                    ? style ? style.badge : "bg-primary text-primary-foreground"
                    : "bg-surface-base text-text-secondary hover:text-text-primary"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      )}

      {/* View tabs: Weather / Insights */}
      {fetched && !loading && records.length > 0 && (
        <div className="flex gap-1 rounded-[var(--radius-card)] bg-surface-base p-1" role="tablist" aria-label="Dashboard view">
          <button
            role="tab"
            aria-selected={activeTab === "weather"}
            onClick={() => setActiveTab("weather")}
            className={`flex-1 min-h-[48px] rounded-[var(--radius-input)] px-4 py-2 text-base font-medium transition-colors ${
              activeTab === "weather" ? "bg-surface-card text-text-primary shadow-sm" : "text-text-tertiary hover:text-text-secondary"
            }`}
          >
            Weather Data
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "insights"}
            onClick={() => setActiveTab("insights")}
            className={`flex-1 min-h-[48px] rounded-[var(--radius-input)] px-4 py-2 text-base font-medium transition-colors ${
              activeTab === "insights" ? "bg-surface-card text-text-primary shadow-sm" : "text-text-tertiary hover:text-text-secondary"
            }`}
          >
            Insights{hasInsights ? ` (${insightsRecords.length}d)` : ""}
          </button>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <span className="ml-3 text-base text-text-secondary">Loading history...</span>
        </div>
      )}

      {error && (
        <div className="rounded-[var(--radius-card)] border border-destructive/30 bg-frost-severe-bg p-4 text-base text-destructive">{error}</div>
      )}

      {fetched && !loading && !error && records.length === 0 && selectedLocation && (
        <div className="rounded-[var(--radius-card)] bg-surface-card p-8 text-center">
          <p className="text-text-secondary">No historical data recorded for {selectedLocation.name} in the last {days} days.</p>
          <p className="mt-2 text-base text-text-tertiary">Historical data is recorded each time weather is fetched. Data builds up over time as the service is used.</p>
        </div>
      )}

      {!fetched && !loading && (
        <div className="rounded-[var(--radius-card)] bg-surface-card p-8 text-center">
          <p className="text-text-secondary">Select a location above to view its historical weather data.</p>
          <p className="mt-2 text-base text-text-tertiary">Browse temperature trends, precipitation totals, UV exposure, wind patterns, and activity insights over time.</p>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════
          WEATHER TAB
         ════════════════════════════════════════════════════════════════════ */}
      {!loading && records.length > 0 && stats && activeTab === "weather" && (
        <>
          <section aria-labelledby="history-summary">
            <h2 id="history-summary" className="text-lg font-semibold text-text-primary font-heading">{selectedLocation?.name} — {DAY_OPTIONS.find((o) => o.value === days)?.label} summary</h2>
            <h3 className="mt-4 text-base font-semibold uppercase tracking-wider text-text-tertiary">Temperature</h3>
            <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Avg High" value={`${stats.avgHigh}°C`} />
              <StatCard label="Avg Low" value={`${stats.avgLow}°C`} />
              <StatCard label="Record High" value={`${stats.maxTemp}°C`} />
              <StatCard label="Record Low" value={`${stats.minTemp}°C`} />
              <StatCard label="Feels-Like High" value={`${stats.avgFeelsHigh}°C`} />
              <StatCard label="Feels-Like Low" value={`${stats.avgFeelsLow}°C`} />
            </div>
            <h3 className="mt-4 text-base font-semibold uppercase tracking-wider text-text-tertiary">Precipitation</h3>
            <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Total Rain" value={`${stats.totalRain} mm`} />
              <StatCard label="Rainy Days" value={`${stats.rainyDays}`} />
              <StatCard label="Avg Rain Chance" value={`${stats.avgRainProb}%`} />
            </div>
            <h3 className="mt-4 text-base font-semibold uppercase tracking-wider text-text-tertiary">Atmosphere</h3>
            <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Avg Humidity" value={`${stats.avgHumidity}%`} />
              <StatCard label="Avg Cloud Cover" value={`${stats.avgCloudCover}%`} />
              <StatCard label="Avg Pressure" value={`${stats.avgPressure} hPa`} />
              <StatCard label="Avg UV" value={`${stats.avgUv} (${uvLevel(stats.avgUv).label})`} />
              <StatCard label="Peak UV" value={`${stats.maxUv}`} />
            </div>
            <h3 className="mt-4 text-base font-semibold uppercase tracking-wider text-text-tertiary">Wind & Daylight</h3>
            <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Avg Wind" value={`${stats.avgWind} km/h`} />
              <StatCard label="Max Gusts" value={`${stats.maxGusts} km/h`} />
              {stats.avgDaylight != null && <StatCard label="Avg Daylight" value={`${stats.avgDaylight} hrs`} />}
              <StatCard label="Data Points" value={`${records.length}`} />
            </div>
          </section>

          {/* ── AI Analysis ──────────────────────────────────────────── */}
          {selectedLocation && (
            <LazySection label="history-ai" fallback={<ChartSkeleton aspect="aspect-[16/4]" />}>
              <ChartErrorBoundary name="AI analysis">
                <HistoryAnalysis
                  locationSlug={selectedLocation.slug}
                  locationName={selectedLocation.name}
                  days={days}
                  dataPoints={records.length}
                />
              </ChartErrorBoundary>
            </LazySection>
          )}

          {/* ── Temperature trend ──────────────────────────────────────── */}
          <LazySection label="history-temp" fallback={<ChartSkeleton aspect="aspect-[16/6]" />}>
            <ChartErrorBoundary name="temperature trend">
              <section aria-labelledby="history-temp-chart">
                <h2 id="history-temp-chart" className="text-lg font-semibold text-text-primary font-heading">Temperature trend</h2>
                <p className="mt-1 text-base text-text-tertiary">Actual high/low and feels-like (apparent) temperatures</p>
                <div className="mt-3 rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm">
                  <TemperatureTrendChart data={chartData} showDots={showDots} tooltipTitle={formatDateFull} xTickFormat={formatDate} />
                  <div className="mt-2 flex flex-wrap items-center justify-center gap-4 text-base text-text-tertiary">
                    <span className="flex items-center gap-1"><span className="inline-block h-2 w-4 rounded-sm bg-chart-1" /> High</span>
                    <span className="flex items-center gap-1"><span className="inline-block h-2 w-4 rounded-sm bg-chart-2" /> Low</span>
                    <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 border-t-2 border-dashed border-chart-3" /> Feels High</span>
                    <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 border-t-2 border-dashed border-chart-4" /> Feels Low</span>
                  </div>
                </div>
              </section>
            </ChartErrorBoundary>
          </LazySection>

          {/* ── Precipitation ──────────────────────────────────────────── */}
          <LazySection label="history-precip" fallback={<ChartSkeleton />}>
            <ChartErrorBoundary name="precipitation">
              <section aria-labelledby="history-rain-chart">
                <h2 id="history-rain-chart" className="text-lg font-semibold text-text-primary font-heading">Precipitation & rain probability</h2>
                <div className="mt-3 rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm">
                  <PrecipitationChart data={chartData} tooltipTitle={formatDateFull} xTickFormat={formatDate} />
                  <div className="mt-2 flex items-center justify-center gap-4 text-base text-text-tertiary">
                    <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-sm bg-rain opacity-60" /> Rainfall</span>
                    <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 border-t-2 border-dashed border-chart-5" /> Probability</span>
                  </div>
                </div>
              </section>
            </ChartErrorBoundary>
          </LazySection>

          {/* ── UV & Cloud Cover ───────────────────────────────────────── */}
          <LazySection label="history-uv-cloud" fallback={<ChartSkeleton />}>
            <ChartErrorBoundary name="UV and cloud cover">
              <section aria-labelledby="history-uv-cloud-chart">
                <h2 id="history-uv-cloud-chart" className="text-lg font-semibold text-text-primary font-heading">UV index & cloud cover</h2>
                <div className="mt-3 rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm">
                  <UVCloudChart data={chartData} tooltipTitle={formatDateFull} xTickFormat={formatDate} />
                  <div className="mt-2 flex items-center justify-center gap-4 text-base text-text-tertiary">
                    <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-sm bg-chart-3 opacity-50" /> UV Index</span>
                    <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 bg-chart-2" /> Cloud Cover</span>
                  </div>
                </div>
              </section>
            </ChartErrorBoundary>
          </LazySection>

          {/* ── Wind ───────────────────────────────────────────────────── */}
          <LazySection label="history-wind" fallback={<ChartSkeleton />}>
            <ChartErrorBoundary name="wind">
              <section aria-labelledby="history-wind-chart">
                <h2 id="history-wind-chart" className="text-lg font-semibold text-text-primary font-heading">Wind speed & gusts</h2>
                <div className="mt-3 rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm">
                  <WindSpeedChart data={chartData} labelKey="date" showDots={showDots} tooltipTitle={formatDateFull} xTickFormat={formatDate} />
                  <div className="mt-2 flex items-center justify-center gap-4 text-base text-text-tertiary">
                    <span className="flex items-center gap-1"><span className="inline-block h-2 w-4 rounded-sm bg-chart-1" /> Speed</span>
                    <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 border-t-2 border-dashed border-chart-4" /> Gusts</span>
                  </div>
                </div>
              </section>
            </ChartErrorBoundary>
          </LazySection>

          {/* ── Pressure ───────────────────────────────────────────────── */}
          <LazySection label="history-pressure" fallback={<ChartSkeleton aspect="aspect-[16/4]" />}>
            <ChartErrorBoundary name="pressure">
              <section aria-labelledby="history-pressure-chart">
                <h2 id="history-pressure-chart" className="text-lg font-semibold text-text-primary font-heading">Barometric pressure</h2>
                <div className="mt-3 rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm">
                  <PressureChart data={chartData} labelKey="date" aspect="aspect-[16/4]" showDots={showDots} tooltipTitle={formatDateFull} xTickFormat={formatDate} />
                </div>
              </section>
            </ChartErrorBoundary>
          </LazySection>

          {/* ── Humidity ───────────────────────────────────────────────── */}
          <LazySection label="history-humidity" fallback={<ChartSkeleton aspect="aspect-[16/4]" />}>
            <ChartErrorBoundary name="humidity">
              <section aria-labelledby="history-humidity-chart">
                <h2 id="history-humidity-chart" className="text-lg font-semibold text-text-primary font-heading">Humidity</h2>
                <div className="mt-3 rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm">
                  <HumidityChart data={chartData} showDots={showDots} tooltipTitle={formatDateFull} xTickFormat={formatDate} />
                </div>
              </section>
            </ChartErrorBoundary>
          </LazySection>

          {/* ── Daylight ───────────────────────────────────────────────── */}
          {records.some((r) => r.daylightHours > 0) && (
            <LazySection label="history-daylight" fallback={<ChartSkeleton aspect="aspect-[16/4]" />}>
              <ChartErrorBoundary name="daylight hours">
                <section aria-labelledby="history-daylight-chart">
                  <h2 id="history-daylight-chart" className="text-lg font-semibold text-text-primary font-heading">Daylight hours</h2>
                  <p className="mt-1 text-base text-text-tertiary">Sunrise to sunset duration — useful for farming and outdoor planning</p>
                  <div className="mt-3 rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm">
                    <DaylightChart data={chartData} showDots={showDots} tooltipTitle={formatDateFull} xTickFormat={formatDate} />
                  </div>
                </section>
              </ChartErrorBoundary>
            </LazySection>
          )}

          {/* ── Daily Records Table ────────────────────────────────────── */}
          <LazySection label="history-table" fallback={<ChartSkeleton aspect="aspect-[16/8]" />}>
            <section aria-labelledby="history-table-heading">
              <h2 id="history-table-heading" className="text-lg font-semibold text-text-primary font-heading">Daily records</h2>
              <div className="mt-3 overflow-x-auto rounded-[var(--radius-card)] bg-surface-card shadow-sm [overscroll-behavior-x:contain]">
                <table className="w-full text-left text-base">
                  <thead>
                    <tr className="border-b border-text-tertiary/10">
                      <th className="px-3 py-3 font-medium text-text-secondary">Date</th>
                      <th className="px-3 py-3 font-medium text-text-secondary">Condition</th>
                      <th className="px-3 py-3 font-medium text-text-secondary text-right">High</th>
                      <th className="px-3 py-3 font-medium text-text-secondary text-right">Low</th>
                      <th className="hidden px-3 py-3 font-medium text-text-secondary text-right sm:table-cell">Feels</th>
                      <th className="px-3 py-3 font-medium text-text-secondary text-right">Rain</th>
                      <th className="hidden px-3 py-3 font-medium text-text-secondary text-right md:table-cell">Prob</th>
                      <th className="hidden px-3 py-3 font-medium text-text-secondary text-right sm:table-cell">Humidity</th>
                      <th className="hidden px-3 py-3 font-medium text-text-secondary text-right md:table-cell">Cloud</th>
                      <th className="hidden px-3 py-3 font-medium text-text-secondary text-right sm:table-cell">Wind</th>
                      <th className="hidden px-3 py-3 font-medium text-text-secondary text-right md:table-cell">Gusts</th>
                      <th className="hidden px-3 py-3 font-medium text-text-secondary text-right lg:table-cell">Dir</th>
                      <th className="hidden px-3 py-3 font-medium text-text-secondary text-right md:table-cell">UV</th>
                      <th className="hidden px-3 py-3 font-medium text-text-secondary text-right lg:table-cell">Pres.</th>
                      <th className="hidden px-3 py-3 font-medium text-text-secondary text-right lg:table-cell">Rise</th>
                      <th className="hidden px-3 py-3 font-medium text-text-secondary text-right lg:table-cell">Set</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.slice().reverse().slice(0, visibleRowCount).map((r) => (
                      <tr key={r.date} className="border-b border-text-tertiary/5 hover:bg-surface-dim/50 transition-colors">
                        <td className="px-3 py-2 text-text-primary font-mono text-base whitespace-nowrap">{new Date(r.date).toLocaleDateString("en-ZW", { day: "numeric", month: "short", year: "numeric" })}</td>
                        <td className="px-3 py-2 text-text-secondary text-base truncate max-w-[120px]" title={r.condition}>{r.condition}</td>
                        <td className="px-3 py-2 text-right text-text-primary">{r.tempHigh}°</td>
                        <td className="px-3 py-2 text-right text-text-secondary">{r.tempLow}°</td>
                        <td className="hidden px-3 py-2 text-right text-text-tertiary text-base sm:table-cell">{r.feelsLikeHigh}°/{r.feelsLikeLow}°</td>
                        <td className="px-3 py-2 text-right text-text-secondary">{r.precipitation} mm</td>
                        <td className="hidden px-3 py-2 text-right text-text-tertiary md:table-cell">{r.rainProbability}%</td>
                        <td className="hidden px-3 py-2 text-right text-text-secondary sm:table-cell">{r.humidity}%</td>
                        <td className="hidden px-3 py-2 text-right text-text-tertiary md:table-cell">{r.cloudCover}%</td>
                        <td className="hidden px-3 py-2 text-right text-text-secondary sm:table-cell">{r.windSpeed}</td>
                        <td className="hidden px-3 py-2 text-right text-text-tertiary md:table-cell">{r.windGusts}</td>
                        <td className="hidden px-3 py-2 text-right text-text-tertiary text-base lg:table-cell">{r.windDirectionLabel}</td>
                        <td className="hidden px-3 py-2 text-right text-text-secondary md:table-cell">{Math.round(r.uvIndex)}</td>
                        <td className="hidden px-3 py-2 text-right text-text-tertiary text-base lg:table-cell">{r.pressure}</td>
                        <td className="hidden px-3 py-2 text-right text-text-tertiary text-base lg:table-cell">{r.sunrise}</td>
                        <td className="hidden px-3 py-2 text-right text-text-tertiary text-base lg:table-cell">{r.sunset}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {records.length > visibleRowCount && (
                  <div ref={tableEndRef} className="py-4 text-center text-base text-text-tertiary">Loading more rows...</div>
                )}
              </div>
            </section>
          </LazySection>
        </>
      )}

      {/* ════════════════════════════════════════════════════════════════════
          INSIGHTS TAB
         ════════════════════════════════════════════════════════════════════ */}
      {!loading && records.length > 0 && activeTab === "insights" && (
        <>
          {!hasInsights && (
            <div className="rounded-[var(--radius-card)] bg-surface-card p-8 text-center">
              <p className="text-text-secondary">No insights data available for this period.</p>
              <p className="mt-2 text-base text-text-tertiary">
                Insights (dew point, heat stress, thunderstorm risk, visibility, GDD) are recorded when
                Tomorrow.io is the weather provider. Data will appear here as it accumulates.
              </p>
            </div>
          )}

          {hasInsights && insightsStats && (
            <>
              {/* ── Activity suitability gauges ─────────────────────────── */}
              <section aria-labelledby="history-suitability">
                <h2 id="history-suitability" className="text-lg font-semibold text-text-primary font-heading">
                  Activity Suitability — {DAY_OPTIONS.find((o) => o.value === days)?.label} overview
                </h2>
                <p className="mt-1 text-base text-text-tertiary">
                  Based on {insightsStats.insightDays} days of Tomorrow.io insights data
                </p>
                {filteredSuitability.length > 0 ? (
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {filteredSuitability.map((s) => (
                      <SuitabilityGauge
                        key={s.category}
                        label={s.label}
                        level={s.level}
                        levelLabel={s.levelLabel}
                        colorClass={s.colorClass}
                        bgClass={s.bgClass}
                        detail={s.detail}
                        icon={s.icon}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-base text-text-tertiary">No suitability data for this category.</p>
                )}
              </section>

              {/* ── Insights summary stats ──────────────────────────────── */}
              <section aria-labelledby="history-insights-stats">
                <h2 id="history-insights-stats" className="text-lg font-semibold text-text-primary font-heading">Insights summary</h2>
                <h3 className="mt-4 text-base font-semibold uppercase tracking-wider text-text-tertiary">Safety & Comfort</h3>
                <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <StatCard label="Avg Heat Stress" value={`${insightsStats.avgHeatStress} (${heatStressLevel(insightsStats.avgHeatStress).label})`} />
                  <StatCard label="Peak Heat Stress" value={`${insightsStats.maxHeatStress} (${heatStressLevel(insightsStats.maxHeatStress).label})`} />
                  <StatCard label="Avg Storm Risk" value={`${Math.round(insightsStats.avgThunderstorm)}%`} />
                  <StatCard label="Peak Storm Risk" value={`${Math.round(insightsStats.maxThunderstorm)}%`} />
                  <StatCard label="Avg UV Concern" value={`${insightsStats.avgUvConcern} (${uvConcernLabel(insightsStats.avgUvConcern).label})`} />
                  <StatCard label="Avg Visibility" value={`${insightsStats.avgVisibility} km`} />
                </div>
                <h3 className="mt-4 text-base font-semibold uppercase tracking-wider text-text-tertiary">Farming & Agriculture</h3>
                <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <StatCard label="Avg Dew Point" value={`${insightsStats.avgDewPoint}°C`} />
                  <StatCard label="Avg GDD (Maize)" value={`${insightsStats.avgGddMaize}`} />
                  <StatCard label="Total ET" value={`${insightsStats.totalET} mm`} />
                  <StatCard label="Insight Days" value={`${insightsStats.insightDays}`} />
                </div>
              </section>

              {/* ── Heat Stress chart ───────────────────────────────────── */}
              {insightsRecords.some((r) => r.heatStress != null) && (
                <LazySection label="history-heat-stress" fallback={<ChartSkeleton />}>
                  <ChartErrorBoundary name="heat stress">
                    <section aria-labelledby="history-heat-stress-chart">
                      <h2 id="history-heat-stress-chart" className="text-lg font-semibold text-text-primary font-heading">Heat stress index</h2>
                      <p className="mt-1 text-base text-text-tertiary">EZ Heat Stress Index — above 24 is moderate, above 28 is severe</p>
                      <div className="mt-3 rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm">
                        <HeatStressChart data={insightsChartData} showDots={showDots} tooltipTitle={formatDateFull} xTickFormat={formatDate} />
                      </div>
                    </section>
                  </ChartErrorBoundary>
                </LazySection>
              )}

              {/* ── Thunderstorm probability chart ─────────────────────── */}
              {insightsRecords.some((r) => r.thunderstorm != null) && (
                <LazySection label="history-thunderstorm" fallback={<ChartSkeleton />}>
                  <ChartErrorBoundary name="thunderstorm probability">
                    <section aria-labelledby="history-thunderstorm-chart">
                      <h2 id="history-thunderstorm-chart" className="text-lg font-semibold text-text-primary font-heading">Thunderstorm probability</h2>
                      <p className="mt-1 text-base text-text-tertiary">Lightning and storm risk — above 40% unsafe for sports, above 50% unsafe for mining</p>
                      <div className="mt-3 rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm">
                        <ThunderstormChart data={insightsChartData} showDots={showDots} tooltipTitle={formatDateFull} xTickFormat={formatDate} />
                      </div>
                    </section>
                  </ChartErrorBoundary>
                </LazySection>
              )}

              {/* ── Dew Point chart ────────────────────────────────────── */}
              {insightsRecords.some((r) => r.dewPoint != null) && (
                <LazySection label="history-dew-point" fallback={<ChartSkeleton />}>
                  <ChartErrorBoundary name="dew point">
                    <section aria-labelledby="history-dewpoint-chart">
                      <h2 id="history-dewpoint-chart" className="text-lg font-semibold text-text-primary font-heading">Dew point</h2>
                      <p className="mt-1 text-base text-text-tertiary">Below 5°C indicates cold, dry air stress; above 20°C indicates crop disease risk</p>
                      <div className="mt-3 rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm">
                        <DewPointChart data={insightsChartData} showDots={showDots} tooltipTitle={formatDateFull} xTickFormat={formatDate} />
                      </div>
                    </section>
                  </ChartErrorBoundary>
                </LazySection>
              )}

              {/* ── Visibility chart ───────────────────────────────────── */}
              {insightsRecords.some((r) => r.visibility != null) && (
                <LazySection label="history-visibility" fallback={<ChartSkeleton />}>
                  <ChartErrorBoundary name="visibility">
                    <section aria-labelledby="history-visibility-chart">
                      <h2 id="history-visibility-chart" className="text-lg font-semibold text-text-primary font-heading">Visibility</h2>
                      <p className="mt-1 text-base text-text-tertiary">Below 5 km is reduced, below 1 km is very poor — affects travel and photography</p>
                      <div className="mt-3 rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm">
                        <VisibilityChart data={insightsChartData} showDots={showDots} tooltipTitle={formatDateFull} xTickFormat={formatDate} />
                      </div>
                    </section>
                  </ChartErrorBoundary>
                </LazySection>
              )}

              {/* ── GDD chart (farming) ────────────────────────────────── */}
              {insightsRecords.some((r) => r.gddMaize != null) && (
                <LazySection label="history-gdd" fallback={<ChartSkeleton />}>
                  <ChartErrorBoundary name="growing degree days">
                    <section aria-labelledby="history-gdd-chart">
                      <h2 id="history-gdd-chart" className="text-lg font-semibold text-text-primary font-heading">Growing degree days (GDD)</h2>
                      <p className="mt-1 text-base text-text-tertiary">Crop growth potential — higher values mean more growth for that day</p>
                      <div className="mt-3 rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm">
                        <GDDChart data={insightsChartData} showDots={showDots} tooltipTitle={formatDateFull} xTickFormat={formatDate} />
                        <div className="mt-2 flex flex-wrap items-center justify-center gap-4 text-base text-text-tertiary">
                          <span className="flex items-center gap-1"><span className="inline-block h-2 w-4 rounded-sm bg-mineral-malachite" /> Maize/Soybean</span>
                          <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 border-t-2 border-dashed border-chart-3" /> Sorghum</span>
                          <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 border-t-2 border-dashed border-chart-4" /> Potatoes</span>
                        </div>
                      </div>
                    </section>
                  </ChartErrorBoundary>
                </LazySection>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
