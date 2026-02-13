"use client";

import { useState, useCallback } from "react";
import { Area, Bar, ComposedChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { LOCATIONS, searchLocations, type ZimbabweLocation } from "@/lib/locations";
import type { WeatherHistoryDoc } from "@/lib/db";

type DayRange = 7 | 14 | 30 | 90 | 180 | 365;

interface HistoryRecord {
  date: string;
  tempHigh: number;
  tempLow: number;
  precipitation: number;
  humidity: number;
  windSpeed: number;
  weatherCode: number;
}

function transformHistory(docs: WeatherHistoryDoc[]): HistoryRecord[] {
  return docs
    .map((doc) => ({
      date: doc.date,
      tempHigh: doc.daily?.temperature_2m_max?.[0] != null
        ? Math.round(doc.daily.temperature_2m_max[0])
        : Math.round(doc.current.temperature_2m),
      tempLow: doc.daily?.temperature_2m_min?.[0] != null
        ? Math.round(doc.daily.temperature_2m_min[0])
        : Math.round(doc.current.temperature_2m - 5),
      precipitation: doc.daily?.precipitation_sum?.[0] ?? doc.current.precipitation,
      humidity: doc.current.relative_humidity_2m,
      windSpeed: Math.round(doc.current.wind_speed_10m),
      weatherCode: doc.current.weather_code,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

const chartConfig = {
  tempHigh: { label: "High", color: "var(--chart-1)" },
  tempLow: { label: "Low", color: "var(--chart-2)" },
  precipitation: { label: "Rain (mm)", color: "var(--color-rain)" },
} satisfies ChartConfig;

const DAY_OPTIONS: { value: DayRange; label: string }[] = [
  { value: 7, label: "7 days" },
  { value: 14, label: "14 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "3 months" },
  { value: 180, label: "6 months" },
  { value: 365, label: "1 year" },
];

export function HistoryDashboard() {
  const [query, setQuery] = useState("");
  const [selectedLocation, setSelectedLocation] = useState<ZimbabweLocation | null>(null);
  const [days, setDays] = useState<DayRange>(30);
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [fetched, setFetched] = useState(false);

  const results = query.length > 0 ? searchLocations(query) : LOCATIONS.slice(0, 10);

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

  // Summary statistics
  const stats = records.length > 0
    ? {
        avgHigh: Math.round(records.reduce((s, r) => s + r.tempHigh, 0) / records.length),
        avgLow: Math.round(records.reduce((s, r) => s + r.tempLow, 0) / records.length),
        maxTemp: Math.max(...records.map((r) => r.tempHigh)),
        minTemp: Math.min(...records.map((r) => r.tempLow)),
        totalRain: Math.round(records.reduce((s, r) => s + r.precipitation, 0) * 10) / 10,
        avgHumidity: Math.round(records.reduce((s, r) => s + r.humidity, 0) / records.length),
        avgWind: Math.round(records.reduce((s, r) => s + r.windSpeed, 0) / records.length),
      }
    : null;

  // Format the date for chart labels based on range
  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    if (days <= 14) {
      return d.toLocaleDateString("en-ZW", { day: "numeric", month: "short" });
    }
    if (days <= 90) {
      return d.toLocaleDateString("en-ZW", { day: "numeric", month: "short" });
    }
    return d.toLocaleDateString("en-ZW", { month: "short", year: "2-digit" });
  };

  const tickInterval = days <= 14 ? 0 : days <= 30 ? 2 : days <= 90 ? 6 : days <= 180 ? 14 : 30;

  return (
    <div className="mt-8 space-y-6">
      {/* Search and filters */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
        {/* Location search */}
        <div className="relative flex-1">
          <label htmlFor="history-search" className="mb-1 block text-sm font-medium text-text-secondary">
            Location
          </label>
          <input
            id="history-search"
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setShowDropdown(true);
            }}
            onFocus={() => setShowDropdown(true)}
            placeholder="Search Zimbabwe locations..."
            className="w-full rounded-[var(--radius-input)] border border-input bg-surface-card px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-primary"
            autoComplete="off"
          />
          {showDropdown && results.length > 0 && (
            <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-[var(--radius-input)] border border-input bg-surface-card shadow-md">
              {results.map((loc) => (
                <li key={loc.slug}>
                  <button
                    type="button"
                    className="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-surface-dim transition-colors"
                    onClick={() => handleSelectLocation(loc)}
                  >
                    <span className="font-medium">{loc.name}</span>
                    <span className="ml-2 text-text-tertiary">{loc.province}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Day range selector */}
        <div>
          <label htmlFor="history-days" className="mb-1 block text-sm font-medium text-text-secondary">
            Time period
          </label>
          <select
            id="history-days"
            value={days}
            onChange={(e) => handleDaysChange(Number(e.target.value) as DayRange)}
            className="rounded-[var(--radius-input)] border border-input bg-surface-card px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
          >
            {DAY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <span className="ml-3 text-sm text-text-secondary">Loading history...</span>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="rounded-[var(--radius-card)] border border-destructive/30 bg-frost-severe-bg p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Empty state */}
      {fetched && !loading && !error && records.length === 0 && selectedLocation && (
        <div className="rounded-[var(--radius-card)] bg-surface-card p-8 text-center">
          <p className="text-text-secondary">
            No historical data recorded for {selectedLocation.name} in the last {days} days.
          </p>
          <p className="mt-2 text-xs text-text-tertiary">
            Historical data is recorded each time weather is fetched. Data builds up over time as the
            service is used.
          </p>
        </div>
      )}

      {/* Prompt state */}
      {!fetched && !loading && (
        <div className="rounded-[var(--radius-card)] bg-surface-card p-8 text-center">
          <p className="text-text-secondary">
            Select a location above to view its historical weather data.
          </p>
          <p className="mt-2 text-xs text-text-tertiary">
            Browse temperature trends, precipitation totals, and climate patterns over time.
          </p>
        </div>
      )}

      {/* Results */}
      {!loading && records.length > 0 && stats && (
        <>
          {/* Summary stat cards */}
          <section aria-labelledby="history-summary">
            <h2 id="history-summary" className="text-lg font-semibold text-text-primary font-heading">
              {selectedLocation?.name} — {DAY_OPTIONS.find((o) => o.value === days)?.label} summary
            </h2>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Avg High" value={`${stats.avgHigh}°C`} />
              <StatCard label="Avg Low" value={`${stats.avgLow}°C`} />
              <StatCard label="Record High" value={`${stats.maxTemp}°C`} />
              <StatCard label="Record Low" value={`${stats.minTemp}°C`} />
              <StatCard label="Total Rain" value={`${stats.totalRain} mm`} />
              <StatCard label="Avg Humidity" value={`${stats.avgHumidity}%`} />
              <StatCard label="Avg Wind" value={`${stats.avgWind} km/h`} />
              <StatCard label="Data Points" value={`${records.length}`} />
            </div>
          </section>

          {/* Temperature chart */}
          <section aria-labelledby="history-temp-chart">
            <h2 id="history-temp-chart" className="text-lg font-semibold text-text-primary font-heading">
              Temperature trend
            </h2>
            <div className="mt-3 rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm">
              <ChartContainer config={chartConfig} className="aspect-[16/6] w-full">
                <ComposedChart data={records} margin={{ top: 8, right: 4, bottom: 0, left: -20 }}>
                  <defs>
                    <linearGradient id="histHighGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-tempHigh)" stopOpacity={0.25} />
                      <stop offset="100%" stopColor="var(--color-tempHigh)" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="histLowGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-tempLow)" stopOpacity={0.15} />
                      <stop offset="100%" stopColor="var(--color-tempLow)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    vertical={false}
                    stroke="var(--color-text-tertiary)"
                    strokeOpacity={0.15}
                  />
                  <XAxis
                    dataKey="date"
                    tickFormatter={formatDate}
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    fontSize={11}
                    interval={tickInterval}
                    tick={{ fill: "var(--color-text-tertiary)" }}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) => `${v}°`}
                    fontSize={11}
                    tick={{ fill: "var(--color-text-tertiary)" }}
                    width={40}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        formatter={(value, name) => {
                          if (name === "tempHigh") return `High: ${value}°C`;
                          if (name === "tempLow") return `Low: ${value}°C`;
                          return `${value}`;
                        }}
                        labelFormatter={(label) => {
                          const d = new Date(label as string);
                          return d.toLocaleDateString("en-ZW", {
                            weekday: "short",
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          });
                        }}
                      />
                    }
                  />
                  <Area
                    type="monotone"
                    dataKey="tempHigh"
                    stroke="var(--color-tempHigh)"
                    strokeWidth={2}
                    fill="url(#histHighGrad)"
                    dot={records.length <= 31}
                    activeDot={{ r: 4, strokeWidth: 2 }}
                  />
                  <Area
                    type="monotone"
                    dataKey="tempLow"
                    stroke="var(--color-tempLow)"
                    strokeWidth={2}
                    fill="url(#histLowGrad)"
                    dot={records.length <= 31}
                    activeDot={{ r: 4, strokeWidth: 2 }}
                    strokeDasharray="4 3"
                  />
                </ComposedChart>
              </ChartContainer>
              <div className="mt-2 flex items-center justify-center gap-4 text-xs text-text-tertiary">
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2 w-4 rounded-sm bg-chart-1" /> High
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2 w-4 rounded-sm bg-chart-2" /> Low
                </span>
              </div>
            </div>
          </section>

          {/* Precipitation chart */}
          <section aria-labelledby="history-rain-chart">
            <h2 id="history-rain-chart" className="text-lg font-semibold text-text-primary font-heading">
              Precipitation
            </h2>
            <div className="mt-3 rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm">
              <ChartContainer config={chartConfig} className="aspect-[16/4] w-full">
                <ComposedChart data={records} margin={{ top: 8, right: 4, bottom: 0, left: -20 }}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    vertical={false}
                    stroke="var(--color-text-tertiary)"
                    strokeOpacity={0.15}
                  />
                  <XAxis
                    dataKey="date"
                    tickFormatter={formatDate}
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    fontSize={11}
                    interval={tickInterval}
                    tick={{ fill: "var(--color-text-tertiary)" }}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) => `${v} mm`}
                    fontSize={11}
                    tick={{ fill: "var(--color-text-tertiary)" }}
                    width={50}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        formatter={(value) => `${value} mm`}
                        labelFormatter={(label) => {
                          const d = new Date(label as string);
                          return d.toLocaleDateString("en-ZW", {
                            weekday: "short",
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          });
                        }}
                      />
                    }
                  />
                  <Bar
                    dataKey="precipitation"
                    fill="var(--color-rain)"
                    fillOpacity={0.6}
                    radius={[2, 2, 0, 0]}
                  />
                </ComposedChart>
              </ChartContainer>
            </div>
          </section>

          {/* Data table */}
          <section aria-labelledby="history-table">
            <h2 id="history-table" className="text-lg font-semibold text-text-primary font-heading">
              Daily records
            </h2>
            <div className="mt-3 overflow-x-auto rounded-[var(--radius-card)] bg-surface-card shadow-sm">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-text-tertiary/10">
                    <th className="px-4 py-3 font-medium text-text-secondary">Date</th>
                    <th className="px-4 py-3 font-medium text-text-secondary text-right">High</th>
                    <th className="px-4 py-3 font-medium text-text-secondary text-right">Low</th>
                    <th className="px-4 py-3 font-medium text-text-secondary text-right">Rain</th>
                    <th className="hidden px-4 py-3 font-medium text-text-secondary text-right sm:table-cell">Humidity</th>
                    <th className="hidden px-4 py-3 font-medium text-text-secondary text-right sm:table-cell">Wind</th>
                  </tr>
                </thead>
                <tbody>
                  {records.slice().reverse().map((r) => (
                    <tr key={r.date} className="border-b border-text-tertiary/5 hover:bg-surface-dim/50 transition-colors">
                      <td className="px-4 py-2 text-text-primary font-mono text-xs">
                        {new Date(r.date).toLocaleDateString("en-ZW", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </td>
                      <td className="px-4 py-2 text-right text-text-primary">{r.tempHigh}°</td>
                      <td className="px-4 py-2 text-right text-text-secondary">{r.tempLow}°</td>
                      <td className="px-4 py-2 text-right text-text-secondary">{r.precipitation} mm</td>
                      <td className="hidden px-4 py-2 text-right text-text-secondary sm:table-cell">{r.humidity}%</td>
                      <td className="hidden px-4 py-2 text-right text-text-secondary sm:table-cell">{r.windSpeed} km/h</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-card)] bg-surface-card p-3 shadow-sm">
      <p className="text-xs text-text-tertiary">{label}</p>
      <p className="mt-1 text-lg font-semibold text-text-primary font-mono">{value}</p>
    </div>
  );
}
