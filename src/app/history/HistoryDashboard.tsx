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
import { ChartSkeleton } from "@/components/ui/skeleton";
import { LOCATIONS, searchLocations, type ZimbabweLocation } from "@/lib/locations";
import { weatherCodeToInfo, windDirection, uvLevel } from "@/lib/weather";
import type { WeatherHistoryDoc } from "@/lib/db";

type DayRange = 7 | 14 | 30 | 90 | 180 | 365;

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

function transformHistory(docs: WeatherHistoryDoc[]): HistoryRecord[] {
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

const DAY_OPTIONS: { value: DayRange; label: string }[] = [
  { value: 7, label: "7 days" },
  { value: 14, label: "14 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "3 months" },
  { value: 180, label: "6 months" },
  { value: 365, label: "1 year" },
];

function avg(arr: number[]): number {
  return arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : 0;
}

function sum(arr: number[]): number {
  return Math.round(arr.reduce((s, v) => s + v, 0) * 10) / 10;
}

// ── Main component ──────────────────────────────────────────────────────────

export function HistoryDashboard() {
  const [query, setQuery] = useState("");
  const [selectedLocation, setSelectedLocation] = useState<ZimbabweLocation | null>(null);
  const [days, setDays] = useState<DayRange>(30);
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [fetched, setFetched] = useState(false);
  const [visibleRowCount, setVisibleRowCount] = useState(50);
  const tableEndRef = useRef<HTMLDivElement>(null);

  const results = query.length > 0 ? searchLocations(query) : LOCATIONS.slice(0, 10);

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
    async (location: ZimbabweLocation, dayCount: DayRange) => {
      setLoading(true);
      setError(null);
      setFetched(true);
      try {
        const res = await fetch(`/api/history?location=${location.slug}&days=${dayCount}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: "Request failed" }));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const json = await res.json();
        setRecords(transformHistory(json.data));
        setVisibleRowCount(50);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to fetch history");
        setRecords([]);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const handleSelectLocation = (loc: ZimbabweLocation) => {
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

  const chartData = useMemo(() => {
    if (records.length <= 60) return records;
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      const step = Math.ceil(records.length / 60);
      return records.filter((_, i) => i === 0 || i === records.length - 1 || i % step === 0);
    }
    return records;
  }, [records]);

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
          <label htmlFor="history-search" className="mb-1 block text-sm font-medium text-text-secondary">Location</label>
          <input
            id="history-search"
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setShowDropdown(true); }}
            onFocus={() => setShowDropdown(true)}
            placeholder="Search Zimbabwe locations..."
            className="w-full rounded-[var(--radius-input)] border border-input bg-surface-card px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-primary"
            autoComplete="off"
          />
          {showDropdown && results.length > 0 && (
            <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-[var(--radius-input)] border border-input bg-surface-card shadow-md">
              {results.map((loc) => (
                <li key={loc.slug}>
                  <button type="button" className="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-surface-dim transition-colors" onClick={() => handleSelectLocation(loc)}>
                    <span className="font-medium">{loc.name}</span>
                    <span className="ml-2 text-text-tertiary">{loc.province}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <label htmlFor="history-days" className="mb-1 block text-sm font-medium text-text-secondary">Time period</label>
          <select id="history-days" value={days} onChange={(e) => handleDaysChange(Number(e.target.value) as DayRange)} className="rounded-[var(--radius-input)] border border-input bg-surface-card px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary">
            {DAY_OPTIONS.map((opt) => (<option key={opt.value} value={opt.value}>{opt.label}</option>))}
          </select>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <span className="ml-3 text-sm text-text-secondary">Loading history...</span>
        </div>
      )}

      {error && (
        <div className="rounded-[var(--radius-card)] border border-destructive/30 bg-frost-severe-bg p-4 text-sm text-destructive">{error}</div>
      )}

      {fetched && !loading && !error && records.length === 0 && selectedLocation && (
        <div className="rounded-[var(--radius-card)] bg-surface-card p-8 text-center">
          <p className="text-text-secondary">No historical data recorded for {selectedLocation.name} in the last {days} days.</p>
          <p className="mt-2 text-xs text-text-tertiary">Historical data is recorded each time weather is fetched. Data builds up over time as the service is used.</p>
        </div>
      )}

      {!fetched && !loading && (
        <div className="rounded-[var(--radius-card)] bg-surface-card p-8 text-center">
          <p className="text-text-secondary">Select a location above to view its historical weather data.</p>
          <p className="mt-2 text-xs text-text-tertiary">Browse temperature trends, precipitation totals, UV exposure, wind patterns, and climate data over time.</p>
        </div>
      )}

      {!loading && records.length > 0 && stats && (
        <>
          <section aria-labelledby="history-summary">
            <h2 id="history-summary" className="text-lg font-semibold text-text-primary font-heading">{selectedLocation?.name} — {DAY_OPTIONS.find((o) => o.value === days)?.label} summary</h2>
            <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-text-tertiary">Temperature</h3>
            <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Avg High" value={`${stats.avgHigh}°C`} />
              <StatCard label="Avg Low" value={`${stats.avgLow}°C`} />
              <StatCard label="Record High" value={`${stats.maxTemp}°C`} />
              <StatCard label="Record Low" value={`${stats.minTemp}°C`} />
              <StatCard label="Feels-Like High" value={`${stats.avgFeelsHigh}°C`} />
              <StatCard label="Feels-Like Low" value={`${stats.avgFeelsLow}°C`} />
            </div>
            <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-text-tertiary">Precipitation</h3>
            <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Total Rain" value={`${stats.totalRain} mm`} />
              <StatCard label="Rainy Days" value={`${stats.rainyDays}`} />
              <StatCard label="Avg Rain Chance" value={`${stats.avgRainProb}%`} />
            </div>
            <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-text-tertiary">Atmosphere</h3>
            <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Avg Humidity" value={`${stats.avgHumidity}%`} />
              <StatCard label="Avg Cloud Cover" value={`${stats.avgCloudCover}%`} />
              <StatCard label="Avg Pressure" value={`${stats.avgPressure} hPa`} />
              <StatCard label="Avg UV" value={`${stats.avgUv} (${uvLevel(stats.avgUv).label})`} />
              <StatCard label="Peak UV" value={`${stats.maxUv}`} />
            </div>
            <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-text-tertiary">Wind & Daylight</h3>
            <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Avg Wind" value={`${stats.avgWind} km/h`} />
              <StatCard label="Max Gusts" value={`${stats.maxGusts} km/h`} />
              {stats.avgDaylight != null && <StatCard label="Avg Daylight" value={`${stats.avgDaylight} hrs`} />}
              <StatCard label="Data Points" value={`${records.length}`} />
            </div>
          </section>

          {/* ── Temperature trend ──────────────────────────────────────── */}
          <LazySection label="history-temp" fallback={<ChartSkeleton aspect="aspect-[16/6]" />}>
            <ChartErrorBoundary name="temperature trend">
              <section aria-labelledby="history-temp-chart">
                <h2 id="history-temp-chart" className="text-lg font-semibold text-text-primary font-heading">Temperature trend</h2>
                <p className="mt-1 text-xs text-text-tertiary">Actual high/low and feels-like (apparent) temperatures</p>
                <div className="mt-3 rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm">
                  <TemperatureTrendChart data={chartData} showDots={showDots} tooltipTitle={formatDateFull} xTickFormat={formatDate} />
                  <div className="mt-2 flex flex-wrap items-center justify-center gap-4 text-xs text-text-tertiary">
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
                  <div className="mt-2 flex items-center justify-center gap-4 text-xs text-text-tertiary">
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
                  <div className="mt-2 flex items-center justify-center gap-4 text-xs text-text-tertiary">
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
                  <div className="mt-2 flex items-center justify-center gap-4 text-xs text-text-tertiary">
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
                  <p className="mt-1 text-xs text-text-tertiary">Sunrise to sunset duration — useful for farming and outdoor planning</p>
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
              <div className="mt-3 overflow-x-auto rounded-[var(--radius-card)] bg-surface-card shadow-sm">
                <table className="w-full text-left text-sm">
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
                        <td className="px-3 py-2 text-text-primary font-mono text-xs whitespace-nowrap">{new Date(r.date).toLocaleDateString("en-ZW", { day: "numeric", month: "short", year: "numeric" })}</td>
                        <td className="px-3 py-2 text-text-secondary text-xs truncate max-w-[120px]" title={r.condition}>{r.condition}</td>
                        <td className="px-3 py-2 text-right text-text-primary">{r.tempHigh}°</td>
                        <td className="px-3 py-2 text-right text-text-secondary">{r.tempLow}°</td>
                        <td className="hidden px-3 py-2 text-right text-text-tertiary text-xs sm:table-cell">{r.feelsLikeHigh}°/{r.feelsLikeLow}°</td>
                        <td className="px-3 py-2 text-right text-text-secondary">{r.precipitation} mm</td>
                        <td className="hidden px-3 py-2 text-right text-text-tertiary md:table-cell">{r.rainProbability}%</td>
                        <td className="hidden px-3 py-2 text-right text-text-secondary sm:table-cell">{r.humidity}%</td>
                        <td className="hidden px-3 py-2 text-right text-text-tertiary md:table-cell">{r.cloudCover}%</td>
                        <td className="hidden px-3 py-2 text-right text-text-secondary sm:table-cell">{r.windSpeed}</td>
                        <td className="hidden px-3 py-2 text-right text-text-tertiary md:table-cell">{r.windGusts}</td>
                        <td className="hidden px-3 py-2 text-right text-text-tertiary text-xs lg:table-cell">{r.windDirectionLabel}</td>
                        <td className="hidden px-3 py-2 text-right text-text-secondary md:table-cell">{Math.round(r.uvIndex)}</td>
                        <td className="hidden px-3 py-2 text-right text-text-tertiary text-xs lg:table-cell">{r.pressure}</td>
                        <td className="hidden px-3 py-2 text-right text-text-tertiary text-xs lg:table-cell">{r.sunrise}</td>
                        <td className="hidden px-3 py-2 text-right text-text-tertiary text-xs lg:table-cell">{r.sunset}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {records.length > visibleRowCount && (
                  <div ref={tableEndRef} className="py-4 text-center text-xs text-text-tertiary">Loading more rows...</div>
                )}
              </div>
            </section>
          </LazySection>
        </>
      )}
    </div>
  );
}
