"use client";

import { useState, useEffect, useCallback } from "react";
import { useDebounce } from "./use-debounce";

export interface QuickSearchLocation {
  slug: string;
  name: string;
  province?: string;
  country?: string;
}

export interface UseLocationQuickSearchOptions {
  /** Debounce delay in ms before firing the request. Default 300. */
  debounceMs?: number;
  /** Max results requested from /api/py/search. Default 10. */
  limit?: number;
  /** Minimum trimmed query length before a request fires. Default 1. */
  minLength?: number;
}

export interface UseLocationQuickSearchResult {
  query: string;
  setQuery: (query: string) => void;
  results: QuickSearchLocation[];
  loading: boolean;
  /**
   * True when the most recent search request failed (network error or non-OK
   * response). Cleared on the next successful search, empty query, or reset.
   * Callers that surface search failures (e.g. the aviation airport picker)
   * read this; others can ignore it.
   */
  error: boolean;
  /**
   * Synchronously clears both query and results — for "done with this
   * search" moments (a result was picked, or the user cancelled). Clearing
   * `query` alone would still show stale `results` until the debounce delay
   * catches up; this avoids that flash.
   */
  reset: () => void;
}

/**
 * Shared debounced "quick match" location search — the same fast,
 * cancellable /api/py/search lookup used everywhere the app lets a user find
 * a location by typing (My Weather modal's add-location search, Explore's
 * instant quick matches). One place defines the debounce timing, request
 * cancellation, and result shape, so these surfaces can't silently drift
 * from each other again. Callers that need to exclude specific results
 * (e.g. already-saved locations) should filter the returned `results` array
 * themselves rather than passing a filter in here — that keeps filtering
 * client-side and instant instead of forcing a re-fetch.
 */
export function useLocationQuickSearch({
  debounceMs = 300,
  limit = 10,
  minLength = 1,
}: UseLocationQuickSearchOptions = {}): UseLocationQuickSearchResult {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<QuickSearchLocation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const debouncedQuery = useDebounce(query, debounceMs);

  useEffect(() => {
    const q = debouncedQuery.trim();
    if (!q || q.length < minLength) {
      // Deferred via rAF — calling setState synchronously in an effect body
      // trips react-hooks/set-state-in-effect (same pattern used elsewhere,
      // e.g. HomeLanding's auto-GPS effect).
      const raf = requestAnimationFrame(() => {
        setResults([]);
        setError(false);
      });
      return () => cancelAnimationFrame(raf);
    }

    const controller = new AbortController();
    let disposed = false;

    // The whole fetch kickoff (including the setLoading(true) flip) is
    // deferred a frame for the same reason as the empty-query branch above.
    const raf = requestAnimationFrame(() => {
      if (disposed) return;
      setLoading(true);
      fetch(`/api/py/search?q=${encodeURIComponent(q)}&limit=${limit}`, { signal: controller.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`Search failed (${res.status})`);
          const data = await res.json();
          if (!disposed) {
            setResults(data?.locations ?? []);
            setError(false);
          }
        })
        .catch(() => {
          if (!disposed && !controller.signal.aborted) {
            setResults([]);
            setError(true);
          }
        })
        .finally(() => {
          if (!disposed && !controller.signal.aborted) setLoading(false);
        });
    });

    return () => {
      disposed = true;
      controller.abort();
      cancelAnimationFrame(raf);
    };
  }, [debouncedQuery, limit, minLength]);

  const reset = useCallback(() => {
    setQuery("");
    setResults([]);
    setError(false);
  }, []);

  return { query, setQuery, results, loading, error, reset };
}
