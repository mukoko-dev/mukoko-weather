"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import Link from "next/link";
import { SearchIcon, MapPinIcon, SparklesIcon } from "@/lib/weather-icons";
import { Button } from "@/components/ui/button";
import { weatherCodeToInfo } from "@/lib/weather";
import { trackEvent } from "@/lib/analytics";
import { useDebounce } from "@/lib/use-debounce";
import { ShamwariCTA } from "@/components/weather/ShamwariCTA";

interface QuickResult {
  slug: string;
  name: string;
  province?: string;
  country?: string;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchResult {
  slug: string;
  name: string;
  province?: string;
  country?: string;
  tags?: string[];
  temperature?: number;
  weatherCode?: number;
  humidity?: number;
  windSpeed?: number;
}

interface SearchResponse {
  locations: SearchResult[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ExploreSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Instant quick matches (same fast name/tag search + debounce pattern as
  // the My Weather modal's location search) — shown live as the user types,
  // before they commit to the slower AI-powered search below. This is the
  // "functions like other weather searches" part: type a city name, see it
  // immediately, same as every other location search in the app.
  const [quickResults, setQuickResults] = useState<QuickResult[]>([]);
  const [quickLoading, setQuickLoading] = useState(false);
  const debouncedQuery = useDebounce(query, 300);

  useEffect(() => {
    const q = debouncedQuery.trim();
    if (!q) {
      setQuickResults([]);
      return;
    }
    const controller = new AbortController();
    setQuickLoading(true);
    fetch(`/api/py/search?q=${encodeURIComponent(q)}&limit=6`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setQuickResults(data?.locations ?? []))
      .catch(() => {
        if (!controller.signal.aborted) setQuickResults([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setQuickLoading(false);
      });
    return () => controller.abort();
  }, [debouncedQuery]);

  const search = useCallback(
    async (searchQuery: string) => {
      const trimmed = searchQuery.trim();
      if (!trimmed || loading) return;

      setLoading(true);
      setError(null);
      setSearched(true);

      try {
        const res = await fetch("/api/py/explore/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: trimmed }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(
            body?.detail || body?.error || `Request failed (${res.status})`
          );
        }

        const data: SearchResponse = await res.json();
        setResults(data.locations || []);
        setSummary(data.summary || null);
        // Note: query text is tracked (truncated to 100 chars) — disclosed in /privacy under custom event tracking
        trackEvent("explore_search", { query: trimmed.slice(0, 100), resultCount: (data.locations || []).length });
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Search failed. Please try again."
        );
        setResults([]);
        setSummary(null);
      } finally {
        setLoading(false);
      }
    },
    [loading]
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    search(query);
  };

  const shamwariContext = {
    source: "explore" as const,
    exploreQuery: query,
    activities: [],
  };

  return (
    <section aria-labelledby="explore-search-heading" className="space-y-4">
      <div className="flex items-center gap-2">
        <SparklesIcon size={18} className="text-primary" />
        <h2
          id="explore-search-heading"
          className="giraffe text-lg"
        >
          Search
        </h2>
      </div>

      <p className="text-base text-text-secondary">
        Type a city name for instant matches, or search naturally — try
        &quot;farming areas with low frost risk&quot; or &quot;safari
        destinations with warm weather&quot; — for AI-powered results.
      </p>

      <form onSubmit={handleSubmit} className="flex gap-2">
        <div className="relative flex-1 min-w-0">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search locations by weather, activity, or condition..."
            className="crane pl-9 pr-4 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Search locations"
            disabled={loading}
          />
          <SearchIcon
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
            aria-hidden="true"
          />
        </div>
        <Button
          type="submit"
          size="sm"
          disabled={loading || !query.trim()}
          className="min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)] shrink-0"
          aria-label="Search"
        >
          {loading ? (
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
          ) : (
            <SearchIcon size={16} />
          )}
        </Button>
      </form>

      {/* Instant quick matches — same fast search everywhere else in the app
          uses, shown live as you type. The AI search below is a deliberate
          extra step (submit) since it's a slower, rate-limited AI call. */}
      {query.trim() && (quickLoading || quickResults.length > 0) && (
        <ul aria-label="Quick location matches" className="space-y-1">
          {quickLoading && quickResults.length === 0 && (
            <li className="h-10 animate-pulse rounded-[var(--radius-input)] bg-surface-base" role="status" aria-label="Loading">
              <span className="sr-only">Loading</span>
            </li>
          )}
          {quickResults.map((loc) => (
            <li key={loc.slug}>
              <Link
                href={`/${loc.slug}`}
                className="flex min-h-[var(--touch-target-min)] items-center gap-3 rounded-[var(--radius-input)] px-3 py-2 text-base text-text-primary hover:bg-surface-card transition-colors"
              >
                <MapPinIcon size={14} className="text-text-tertiary" />
                <div className="min-w-0 flex-1">
                  <span className="block truncate">{loc.name}</span>
                  {loc.province && (
                    <span className="block text-base text-text-tertiary truncate">{loc.province}</span>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <div className="rounded-[var(--radius-card)] border border-destructive/30 bg-frost-severe-bg p-3 text-base text-destructive">
          {error}
        </div>
      )}

      {summary && (
        <div className="flex items-start gap-2 rounded-[var(--radius-card)] bg-primary/5 p-3">
          <SparklesIcon
            size={14}
            className="mt-0.5 shrink-0 text-primary"
          />
          <p className="text-base text-text-secondary">{summary}</p>
        </div>
      )}

      {searched && !loading && results.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {results.map((loc) => (
            <Link
              key={loc.slug}
              href={`/${loc.slug}`}
              className="group card-interactive flex items-start gap-3.5 baobab p-5 focus-visible:outline-2 focus-visible:outline-primary min-h-[var(--touch-target-min)]"
            >
              <div className="hoopoe-lg transition-colors group-hover:bg-primary/20">
                <MapPinIcon size={16} className="text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-text-primary group-hover:text-primary transition-colors truncate">
                  {loc.name}
                </p>
                {loc.province && (
                  <p className="mt-0.5 text-base text-text-tertiary">{loc.province}</p>
                )}
                {loc.temperature != null && (
                  <div className="mt-1.5 flex items-center gap-2 text-base text-text-secondary">
                    <span className="font-medium">
                      {Math.round(loc.temperature)}°C
                    </span>
                    {loc.weatherCode != null && (
                      <span>
                        {weatherCodeToInfo(loc.weatherCode).label}
                      </span>
                    )}
                  </div>
                )}
                {loc.tags && loc.tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {loc.tags.slice(0, 3).map((tag) => (
                      <span
                        key={tag}
                        className="rounded-[var(--radius-badge)] bg-surface-dim px-2 py-0.5 text-base text-text-tertiary"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}

      {searched && !loading && results.length === 0 && !error && (
        <div className="rounded-[var(--radius-card)] bg-surface-card p-6 text-center">
          <p className="text-base text-text-secondary">
            No locations found. Try a different search term.
          </p>
        </div>
      )}

      {searched && results.length > 0 && (
        <div className="flex justify-center">
          <ShamwariCTA
            context={shamwariContext}
            label="Ask Shamwari for more"
            variant="subtle"
          />
        </div>
      )}
    </section>
  );
}
