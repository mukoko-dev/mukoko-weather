"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { SparklesIcon } from "@/lib/weather-icons";
import { useAppStore } from "@/lib/store";
import type { WeatherData } from "@/lib/weather";
import type { ZimbabweLocation } from "@/lib/locations";
import { trackEvent } from "@/lib/analytics";

interface Props {
  weather: WeatherData;
  location: ZimbabweLocation;
  /** Called when the AI summary is successfully loaded — used to pass context to AISummaryChat */
  onSummaryLoaded?: (text: string) => void;
}

/**
 * Wait for the browser to be idle before resolving.
 * Uses requestIdleCallback where available (Chrome, Edge, Firefox),
 * falls back to setTimeout for Safari/iOS.
 */
function waitForIdle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => resolve());
    } else {
      setTimeout(resolve, 200);
    }
  });
}

export function AISummary({ weather, location, onSummaryLoaded }: Props) {
  const [insight, setInsight] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedActivities = useAppStore((s) => s.selectedActivities);
  const abortRef = useRef<AbortController | null>(null);
  const lastFetchedKeyRef = useRef<string>("");

  // Serialize deps to stable strings so Zustand rehydration of an
  // equivalent value (e.g. [] → []) doesn't trigger a re-fetch.
  const activitiesKey = useMemo(() => selectedActivities.slice().sort().join(","), [selectedActivities]);
  const locationKey = `${location.slug}:${location.lat}:${location.lon}`;
  const weatherKey = `${weather.current.temperature_2m}:${weather.current.weather_code}`;
  const fetchKey = `${locationKey}:${weatherKey}:${activitiesKey}`;

  useEffect(() => {
    // Skip duplicate fetches (e.g. from redirect double-render)
    if (lastFetchedKeyRef.current === fetchKey && insight) {
      return;
    }
    lastFetchedKeyRef.current = fetchKey;
    // Abort any in-flight request before starting a new one
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    let cancelled = false;

    async function fetchInsight() {
      await waitForIdle();
      if (cancelled) return;

      setLoading(true);
      setError(null);
      try {
        // Fetch activity labels from MongoDB via API
        let activityLabels: string[] = [];
        if (selectedActivities.length > 0) {
          try {
            const labelsRes = await fetch(`/api/py/activities?labels=${selectedActivities.join(",")}`);
            if (labelsRes.ok) {
              const labelsData = await labelsRes.json();
              activityLabels = labelsData.labels ?? [];
            }
          } catch {
            // Activity labels unavailable — continue without them
          }
        }
        const res = await fetch("/api/py/ai", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            weatherData: {
              current: weather.current,
              daily: {
                temperature_2m_max: weather.daily.temperature_2m_max.slice(0, 3),
                temperature_2m_min: weather.daily.temperature_2m_min.slice(0, 3),
                weather_code: weather.daily.weather_code.slice(0, 3),
                precipitation_probability_max: weather.daily.precipitation_probability_max.slice(0, 3),
              },
              insights: weather.insights,
            },
            location: { name: location.name, lat: location.lat, lon: location.lon, elevation: location.elevation },
            activities: activityLabels,
          }),
        });
        if (!res.ok) {
          throw new Error(`Failed to get AI insight (${res.status})`);
        }
        const data = await res.json();
        if (!cancelled) {
          setInsight(data.insight);
          onSummaryLoaded?.(data.insight);
          trackEvent("ai_summary_loaded", { location: location.slug });
        }
      } catch (err) {
        // Don't show error for intentional aborts
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        if (!cancelled) setError("Unable to load AI summary. Weather data is still available above.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchInsight();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchKey]);

  return (
    <section aria-label="AI weather intelligence summary">
      <div className="rounded-[var(--radius-card)] border border-primary/25 border-l-[6px] border-l-tanzanite bg-surface-card p-5 shadow-sm sm:p-6">
        <div className="flex items-center gap-2">
          <SparklesIcon size={20} className="text-tanzanite" />
          <h2 className="text-lg font-semibold text-text-primary font-heading">
            Shamwari Weather Insight
          </h2>
        </div>

        <div className="mt-4">
          {loading && (
            <div className="space-y-2" role="status" aria-label="Loading AI summary">
              <div className="h-4 w-3/4 animate-pulse rounded bg-text-tertiary/20" />
              <div className="h-4 w-full animate-pulse rounded bg-text-tertiary/20" />
              <div className="h-4 w-2/3 animate-pulse rounded bg-text-tertiary/20" />
              <span className="sr-only">Loading AI weather summary...</span>
            </div>
          )}

          {error && (
            <p className="text-base text-text-secondary">{error}</p>
          )}

          {insight && !loading && (
            <div className="animate-fade-in prose prose-base max-w-none text-text-secondary prose-strong:text-text-primary prose-headings:text-text-primary prose-li:marker:text-text-tertiary">
              <ReactMarkdown>{insight}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
