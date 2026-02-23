"use client";

import { useState, useEffect, useCallback } from "react";
import { useAppStore } from "@/lib/store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Report {
  id: string;
  reportType: string;
  severity: string;
  description?: string;
  reportedAt: string;
  upvotes: number;
  verified: boolean;
  locationName?: string;
}

const REPORT_ICONS: Record<string, string> = {
  "light-rain": "🌦️",
  "heavy-rain": "🌧️",
  thunderstorm: "⛈️",
  hail: "🌨️",
  flooding: "🌊",
  "strong-wind": "💨",
  "clear-skies": "☀️",
  fog: "🌫️",
  dust: "🏜️",
  frost: "❄️",
};

const REPORT_LABELS: Record<string, string> = {
  "light-rain": "Light Rain",
  "heavy-rain": "Heavy Rain",
  thunderstorm: "Thunderstorm",
  hail: "Hail",
  flooding: "Flooding",
  "strong-wind": "Strong Wind",
  "clear-skies": "Clear Skies",
  fog: "Fog",
  dust: "Dust",
  frost: "Frost",
};

const SEVERITY_CLASSES: Record<string, string> = {
  mild: "bg-severity-low/10 text-severity-low",
  moderate: "bg-severity-moderate/10 text-severity-moderate",
  severe: "bg-severity-severe/10 text-severity-severe",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RecentReports({ locationSlug }: { locationSlug: string }) {
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const openReportModal = useAppStore((s) => s.openReportModal);

  useEffect(() => {
    if (!locationSlug) return;

    fetch(`/api/py/reports?location=${locationSlug}&hours=24`)
      .then((res) => (res.ok ? res.json() : { reports: [] }))
      .then((data) => setReports(data.reports || []))
      .catch(() => setReports([]))
      .finally(() => setLoading(false));
  }, [locationSlug]);

  const handleUpvote = useCallback(async (reportId: string) => {
    try {
      const res = await fetch("/api/py/reports/upvote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.upvoted) {
          setReports((prev) =>
            prev.map((r) =>
              r.id === reportId ? { ...r, upvotes: r.upvotes + 1 } : r
            )
          );
        }
      }
    } catch {
      // Silently fail — upvoting is non-critical
    }
  }, []);

  // Don't render section if no reports and not loading
  if (!loading && reports.length === 0) {
    return (
      <section aria-labelledby="community-reports-heading" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 id="community-reports-heading" className="text-base font-semibold text-text-primary font-heading">
            Community Reports
          </h2>
          <button
            type="button"
            onClick={openReportModal}
            className="inline-flex items-center gap-1 rounded-[var(--radius-input)] bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20 min-h-[44px]"
          >
            + Report Weather
          </button>
        </div>
        <p className="text-sm text-text-tertiary">No reports in the last 24 hours. Be the first to report!</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="community-reports-heading" className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 id="community-reports-heading" className="text-base font-semibold text-text-primary font-heading">
          Community Reports
          {reports.length > 0 && (
            <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              {reports.length}
            </span>
          )}
        </h2>
        <button
          type="button"
          onClick={openReportModal}
          className="inline-flex items-center gap-1 rounded-[var(--radius-input)] bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20 min-h-[44px]"
        >
          + Report Weather
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 py-4" role="status">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <span className="text-sm text-text-secondary">Loading reports...</span>
          <span className="sr-only">Loading community weather reports</span>
        </div>
      )}

      {!loading && reports.length > 0 && (
        <div className="space-y-2">
          {reports.map((report) => (
            <div
              key={report.id}
              className="flex items-center gap-3 rounded-[var(--radius-card)] bg-surface-card p-3 shadow-sm"
            >
              <span className="text-lg shrink-0" aria-hidden="true">
                {REPORT_ICONS[report.reportType] || "🌤️"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-primary">
                    {REPORT_LABELS[report.reportType] || report.reportType}
                  </span>
                  <span className={`rounded-[var(--radius-badge)] px-1.5 py-0.5 text-[10px] font-bold uppercase ${SEVERITY_CLASSES[report.severity] || ""}`}>
                    {report.severity}
                  </span>
                  {report.verified && (
                    <span className="rounded-[var(--radius-badge)] bg-severity-low/10 px-1.5 py-0.5 text-[10px] font-bold text-severity-low" title="Verified against API data">
                      Verified
                    </span>
                  )}
                </div>
                {report.description && (
                  <p className="mt-0.5 text-xs text-text-secondary line-clamp-1">{report.description}</p>
                )}
                <p className="mt-0.5 text-[10px] text-text-tertiary">{timeAgo(report.reportedAt)}</p>
              </div>
              <button
                type="button"
                onClick={() => handleUpvote(report.id)}
                className="flex items-center gap-1 rounded-[var(--radius-input)] px-2 py-1 text-xs text-text-tertiary transition-colors hover:text-primary hover:bg-primary/10 min-h-[44px] min-w-[44px] justify-center"
                aria-label={`Upvote report (${report.upvotes} votes)`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m5 12 7-7 7 7" /><path d="M12 19V5" />
                </svg>
                {report.upvotes > 0 && <span>{report.upvotes}</span>}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
