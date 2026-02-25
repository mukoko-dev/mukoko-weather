"use client";

import { useState, useCallback, Component, type ReactNode } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import { SparklesIcon } from "@/lib/weather-icons";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/lib/store";

// ---------------------------------------------------------------------------
// Markdown error boundary
// ---------------------------------------------------------------------------

interface MarkdownErrorBoundaryState {
  hasError: boolean;
}

class MarkdownErrorBoundary extends Component<
  { children: ReactNode; fallback: string },
  MarkdownErrorBoundaryState
> {
  state: MarkdownErrorBoundaryState = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return (
        <p className="text-base text-text-secondary">{this.props.fallback}</p>
      );
    }
    return this.props.children;
  }
}

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
  const setShamwariContext = useAppStore((s) => s.setShamwariContext);

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
          body?.detail || body?.error || `Request failed (${res.status})`
        );
      }

      const data = await res.json();
      setAnalysis(data.analysis);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to generate analysis. Please try again."
      );
    } finally {
      setLoading(false);
    }
  }, [locationSlug, days, selectedActivities]);

  const handleContinueInShamwari = () => {
    setShamwariContext({
      source: "history",
      locationSlug,
      locationName,
      historyDays: days,
      historyAnalysis: analysis ?? undefined,
      activities: selectedActivities,
      timestamp: Date.now(),
    });
  };

  return (
    <section
      aria-labelledby="history-analysis-heading"
      className="rounded-[var(--radius-card)] border-l-4 border-mineral-tanzanite bg-surface-card p-4 shadow-sm"
    >
      <div className="flex items-center gap-2">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10">
          <SparklesIcon size={14} className="text-primary" />
        </div>
        <h2
          id="history-analysis-heading"
          className="text-base font-semibold text-text-primary font-heading"
        >
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
            className="mt-3 min-h-[44px]"
            aria-label="Analyze weather history with AI"
          >
            <SparklesIcon size={14} className="mr-1.5" />
            Analyze with Shamwari
          </Button>
        </div>
      )}

      {loading && (
        <div className="mt-3 flex items-center gap-2" role="status">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <span className="text-base text-text-secondary">
            Analyzing {days}-day history...
          </span>
          <span className="sr-only">
            Shamwari is analyzing weather history
          </span>
        </div>
      )}

      {error && (
        <div className="mt-3">
          <p className="text-base text-destructive">{error}</p>
          <Button
            onClick={analyze}
            size="sm"
            variant="outline"
            className="mt-2 min-h-[44px]"
          >
            Try again
          </Button>
        </div>
      )}

      {analysis && (
        <div className="mt-3">
          <MarkdownErrorBoundary fallback={analysis}>
            <div className="prose prose-sm max-w-none break-words text-text-secondary prose-strong:text-text-primary prose-headings:text-text-primary prose-li:marker:text-text-tertiary">
              <ReactMarkdown>{analysis}</ReactMarkdown>
            </div>
          </MarkdownErrorBoundary>

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Button
              onClick={analyze}
              size="sm"
              variant="outline"
              className="min-h-[44px] text-base"
            >
              Re-analyze
            </Button>
            <Link
              href="/shamwari"
              onClick={handleContinueInShamwari}
              className="inline-flex items-center gap-1 rounded-[var(--radius-input)] bg-primary px-3 py-2 text-base font-medium text-primary-foreground transition-colors hover:bg-primary/90 min-h-[44px]"
            >
              <SparklesIcon size={12} />
              Discuss in Shamwari
            </Link>
          </div>
        </div>
      )}
    </section>
  );
}
