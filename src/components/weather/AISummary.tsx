"use client";

import { useState, useEffect, useCallback } from "react";
import { SparklesIcon } from "@/lib/weather-icons";
import type { WeatherData } from "@/lib/weather";
import type { ZimbabweLocation } from "@/lib/locations";

interface Props {
  weather: WeatherData;
  location: ZimbabweLocation;
}

export function AISummary({ weather, location }: Props) {
  const [insight, setInsight] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchInsight = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          weatherData: {
            current: weather.current,
            daily: {
              temperature_2m_max: weather.daily.temperature_2m_max.slice(0, 3),
              temperature_2m_min: weather.daily.temperature_2m_min.slice(0, 3),
              weather_code: weather.daily.weather_code.slice(0, 3),
              precipitation_probability_max: weather.daily.precipitation_probability_max.slice(0, 3),
            },
          },
          location: { name: location.name, lat: location.lat, lon: location.lon, elevation: location.elevation },
        }),
      });
      if (!res.ok) throw new Error("Failed to get AI insight");
      const data = await res.json();
      setInsight(data.insight);
    } catch {
      setError("Unable to load AI summary. Weather data is still available above.");
    } finally {
      setLoading(false);
    }
  }, [weather, location]);

  useEffect(() => {
    fetchInsight();
  }, [fetchInsight]);

  return (
    <section aria-label="AI weather intelligence summary">
      <div className="rounded-[var(--radius-card)] border-l-4 border-tanzanite bg-surface-card p-4 shadow-sm sm:p-6">
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
            <p className="text-sm text-text-secondary">{error}</p>
          )}

          {insight && !loading && (
            <div className="prose prose-sm max-w-none text-text-secondary">
              {insight.split("\n").map((line, i) => (
                <p key={i} className="mb-2 last:mb-0">{line}</p>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
