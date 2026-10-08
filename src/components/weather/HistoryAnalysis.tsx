"use client";

import { useState, useCallback } from "react";
import { SparklesIcon } from "@/lib/weather-icons";
import { Button } from "@/components/ui/button";
import { SafeMarkdown } from "@/components/ui/safe-markdown";
import { useAppStore } from "@/lib/store";
import { trackEvent } from "@/lib/analytics";
import { ShamwariCTA } from "./ShamwariCTA";
import { Spinner } from "@/components/ui/spinner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HistoryAnalysisProps {
  locationSlug: string;
  locationName: string;
  days: number;
  dataPoints: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HistoryAnalysis({
  locationSlug,
  locationName,
  days,
  dataPoints,
}: HistoryAnalysisProps) {
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedActivities = useAppStore((s) => s.selectedActivities);

  const analyze = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/py/history/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: locationSlug,
          days,
          ...(selectedActivities.length > 0 && {
            activities: selectedActivities,
          }),
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          body?.detail || body?.error || `Request failed (${res.status})`,
        );
      }

      const data = await res.json();
      setAnalysis(data.analysis);
      trackEvent("history_analysis", { location: locationSlug, days });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to generate analysis. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }, [locationSlug, days, selectedActivities]);

  const shamwariContext = {
    source: "history" as const,
    locationSlug,
    locationName,
    historyDays: days,
    historyAnalysis: analysis ?? undefined,
    activities: selectedActivities,
  };

  return (
    <section
      aria-labelledby="history-analysis-heading"
      className="rounded-[var(--radius-card)] border-l-4 border-mineral-tanzanite bg-surface-card p-4 shadow-sm"
    >
      <div className="flex items-center gap-2">
        <div className="hoopoe">
          <SparklesIcon size={14} className="text-primary" />
        </div>
        <h2 id="history-analysis-heading" className="giraffe">
          AI Analysis
        </h2>
      </div>

      {!analysis && !loading && !error && (
        <div className="mt-3">
          <p className="text-base text-text-secondary">
            Let Shamwari analyze {dataPoints} data points for{" "}
            <strong>{locationName}</strong> over {days} days to identify trends,
            patterns, and activity recommendations.
          </p>
          <Button
            onClick={analyze}
            size="sm"
            className="mt-3 min-h-[var(--touch-target-min)]"
            aria-label="Analyze weather history with AI"
          >
            <SparklesIcon size={14} className="mr-1.5" />
            Analyze with Shamwari
          </Button>
        </div>
      )}

      {loading && (
        <div className="mt-3 flex items-center gap-2" role="status">
          <Spinner />
          <span className="text-base text-text-secondary">
            Analyzing {days}-day history...
          </span>
          <span className="sr-only">Shamwari is analyzing weather history</span>
        </div>
      )}

      {error && (
        <div className="mt-3">
          <p className="text-base text-destructive">{error}</p>
          <Button
            onClick={analyze}
            size="sm"
            variant="outline"
            className="mt-2 min-h-[var(--touch-target-min)]"
          >
            Try again
          </Button>
        </div>
      )}

      {analysis && (
        <div className="mt-3">
          <SafeMarkdown content={analysis} size="sm" className="break-words" />

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Button
              onClick={analyze}
              size="sm"
              variant="outline"
              className="min-h-[var(--touch-target-min)] text-base"
            >
              Re-analyze
            </Button>
            <ShamwariCTA
              context={shamwariContext}
              label="Discuss in Shamwari"
              variant="primary"
            />
          </div>
        </div>
      )}
    </section>
  );
}
