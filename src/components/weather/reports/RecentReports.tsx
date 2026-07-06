"use client";

import { useState, useEffect, useCallback } from "react";
import { useAppStore } from "@/lib/store";
import { trackEvent } from "@/lib/analytics";
import { CloudSunIcon, MegaphoneIcon } from "@/lib/weather-icons";
import { getReportTypeInfo } from "@/lib/report-types";
import { Spinner } from "@/components/ui/spinner";

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
          trackEvent("report_upvoted", { reportId, location: locationSlug });
        }
      }
    } catch {
      // Silently fail — upvoting is non-critical
    }
  }, [locationSlug]);

  // Don't render section if no reports and not loading
  if (!loading && reports.length === 0) {
    return (
      <section aria-labelledby="community-reports-heading" className="space-y-3">
        <h2 id="community-reports-heading" className="giraffe">
          Community Reports
        </h2>
        <button
          type="button"
          onClick={openReportModal}
          className="flex w-full items-center gap-3 rounded-[var(--radius-card)] bg-mineral-copper p-4 text-left text-mineral-copper-fg shadow-sm transition-shadow hover:shadow-md min-h-[var(--touch-target-min)]"
        >
          <span aria-hidden="true"><MegaphoneIcon size={20} /></span>
          <div>
            <p className="text-base font-bold">Report Weather</p>
            <p className="text-base opacity-80">No reports in the last 24 hours. Be the first!</p>
          </div>
        </button>
      </section>
    );
  }

  return (
    <section aria-labelledby="community-reports-heading" className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 id="community-reports-heading" className="giraffe">
          Community Reports
          {reports.length > 0 && (
            <span className="ml-2 rounded-full bg-mineral-copper/10 px-2 py-0.5 text-base font-medium text-mineral-copper">
              {reports.length}
            </span>
          )}
        </h2>
        <button
          type="button"
          onClick={openReportModal}
          className="inline-flex items-center gap-2 rounded-[var(--radius-button)] bg-mineral-copper px-4 py-2 text-base font-bold text-mineral-copper-fg transition-shadow hover:shadow-md min-h-[var(--touch-target-min)]"
        >
          <span aria-hidden="true"><MegaphoneIcon size={18} /></span>
          Report Weather
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 py-4" role="status">
          <Spinner className="border-mineral-copper" />
          <span className="text-base text-text-secondary">Loading reports...</span>
          <span className="sr-only">Loading community weather reports</span>
        </div>
      )}

      {!loading && reports.length > 0 && (
        <div className="space-y-2">
          {reports.map((report) => {
            const typeInfo = getReportTypeInfo(report.reportType);
            const TypeIcon = typeInfo?.icon ?? CloudSunIcon;
            return (
            <div
              key={report.id}
              className="flex items-center gap-3 rounded-[var(--radius-card)] border border-mineral-copper/25 bg-surface-card p-3 shadow-sm"
            >
              <span className="shrink-0 text-text-secondary" aria-hidden="true">
                <TypeIcon size={20} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-base font-medium text-text-primary">
                    {typeInfo?.label ?? report.reportType}
                  </span>
                  <span className={`rounded-[var(--radius-badge)] px-1.5 py-0.5 text-base font-bold uppercase ${SEVERITY_CLASSES[report.severity] || ""}`}>
                    {report.severity}
                  </span>
                  {report.verified && (
                    <span className="rounded-[var(--radius-badge)] bg-severity-low/10 px-1.5 py-0.5 text-base font-bold text-severity-low" title="Verified against API data">
                      Verified
                    </span>
                  )}
                </div>
                {report.description && (
                  <p className="mt-0.5 text-base text-text-secondary line-clamp-1">{report.description}</p>
                )}
                <p className="mt-0.5 text-base text-text-tertiary">{timeAgo(report.reportedAt)}</p>
              </div>
              <button
                type="button"
                onClick={() => handleUpvote(report.id)}
                className="flex items-center gap-1 rounded-[var(--radius-input)] px-2 py-1 text-base text-text-tertiary transition-colors hover:text-mineral-copper hover:bg-mineral-copper/10 min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)] justify-center"
                aria-label={`Upvote report (${report.upvotes} votes)`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m5 12 7-7 7 7" /><path d="M12 19V5" />
                </svg>
                {report.upvotes > 0 && <span>{report.upvotes}</span>}
              </button>
            </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
