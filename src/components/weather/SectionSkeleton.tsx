import { Skeleton, MetricCardSkeleton } from "@/components/ui/skeleton";

// ---------------------------------------------------------------------------
// Generic section skeleton (backward-compatible default)
// ---------------------------------------------------------------------------

export function SectionSkeleton({ className }: { className?: string } = {}) {
  return (
    <div className={`animate-pulse rounded-[var(--radius-card)] bg-surface-card ${className ?? "h-32"}`} role="status" aria-label="Loading section" />
  );
}

// ---------------------------------------------------------------------------
// Community Reports skeleton
// Matches: heading + button row, then empty-state text line
// ---------------------------------------------------------------------------

export function ReportsSkeleton() {
  return (
    <div className="space-y-3" role="status" aria-label="Loading community reports">
      {/* Header row: heading + button */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-[48px] w-32 rounded-[var(--radius-input)]" />
      </div>
      {/* Empty-state text placeholder */}
      <Skeleton className="h-4 w-72" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hourly Forecast skeleton
// Matches: card > heading, chart area, horizontal scroll of hourly items
// ---------------------------------------------------------------------------

export function HourlyForecastSkeleton() {
  return (
    <div
      className="rounded-[var(--radius-card)] border border-primary/25 bg-surface-card p-5 shadow-sm sm:p-6"
      role="status"
      aria-label="Loading hourly forecast"
    >
      {/* Heading */}
      <Skeleton className="h-6 w-44" />
      {/* Chart area */}
      <Skeleton className="mt-4 aspect-[16/5] w-full rounded-[var(--radius-card)]" />
      {/* Horizontal scroll items */}
      <div className="mt-5 flex gap-4 overflow-hidden sm:gap-5">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="flex min-w-[72px] shrink-0 flex-col items-center gap-2.5 rounded-[var(--radius-input)] bg-surface-base px-3.5 py-3.5">
            <Skeleton className="h-4 w-10" />
            <Skeleton className="h-6 w-6 rounded-full" />
            <Skeleton className="h-4 w-8" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity Insights skeleton
// Matches: SectionHeader + 2-3 activity cards with icon circle + text rows
// ---------------------------------------------------------------------------

export function ActivityInsightsSkeleton() {
  return (
    <div role="status" aria-label="Loading activity insights">
      {/* Section header: title + Edit action */}
      <div className="mb-4 flex items-center justify-between">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-5 w-10" />
      </div>
      {/* 2 activity cards */}
      <div className="space-y-3">
        {Array.from({ length: 2 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 rounded-[var(--radius-card)] bg-surface-card p-5 shadow-sm border border-primary/25 border-l-[6px] border-l-text-tertiary/20"
          >
            {/* Icon circle */}
            <Skeleton className="h-11 w-11 shrink-0 rounded-full" />
            {/* Text rows */}
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-5 w-16 rounded-[var(--radius-badge)]" />
              </div>
              <Skeleton className="h-3.5 w-full max-w-[280px]" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Daily Forecast skeleton
// Matches: card > heading, chart area, 7 daily rows
// ---------------------------------------------------------------------------

export function DailyForecastSkeleton() {
  return (
    <div
      className="rounded-[var(--radius-card)] border border-primary/25 bg-surface-card p-5 shadow-sm sm:p-6"
      role="status"
      aria-label="Loading daily forecast"
    >
      {/* Heading */}
      <Skeleton className="h-6 w-36" />
      {/* Chart area */}
      <Skeleton className="mt-4 aspect-[16/5] w-full rounded-[var(--radius-card)]" />
      {/* 7 daily rows */}
      <div className="mt-5 space-y-3">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 rounded-[var(--radius-input)] bg-surface-base px-3.5 py-3.5 min-h-[48px] sm:gap-4">
            {/* Day + date */}
            <div className="flex w-12 shrink-0 flex-col items-center gap-1 sm:w-14">
              <Skeleton className="h-3.5 w-8" />
              <Skeleton className="h-5 w-6" />
            </div>
            {/* Icon */}
            <Skeleton className="h-6 w-6 shrink-0 rounded-full" />
            {/* Low temp */}
            <Skeleton className="h-4 w-7 shrink-0" />
            {/* Temp bar */}
            <Skeleton className="mx-1 h-2 flex-1 rounded-full" />
            {/* High temp */}
            <Skeleton className="h-4 w-7 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI Summary skeleton
// Matches: card with tanzanite left border, sparkles icon + heading, 5 text lines
// ---------------------------------------------------------------------------

export function AISummarySkeleton() {
  return (
    <div
      className="rounded-[var(--radius-card)] border border-primary/25 border-l-[6px] border-l-tanzanite bg-surface-card p-5 shadow-sm sm:p-6"
      role="status"
      aria-label="Loading AI summary"
    >
      {/* Header: icon + title */}
      <div className="flex items-center gap-2">
        <Skeleton className="h-5 w-5 rounded" />
        <Skeleton className="h-6 w-56" />
      </div>
      {/* Markdown content lines */}
      <div className="mt-4 space-y-2.5">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-4/5" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI Summary Chat skeleton
// Matches: collapsed state with tanzanite left border, header bar
// ---------------------------------------------------------------------------

export function AISummaryChatSkeleton() {
  return (
    <div
      className="rounded-[var(--radius-card)] border-l-4 border-tanzanite bg-surface-card"
      role="status"
      aria-label="Loading follow-up chat"
    >
      {/* Collapsed header */}
      <div className="flex items-center justify-between px-4 py-3 min-h-[48px]">
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-5 rounded" />
          <Skeleton className="h-5 w-48" />
        </div>
        <Skeleton className="h-5 w-5 rounded" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Atmospheric Summary skeleton
// Matches: SectionHeader + 2×3 grid of MetricCards
// ---------------------------------------------------------------------------

export function AtmosphericSummarySkeleton() {
  return (
    <div role="status" aria-label="Loading atmospheric conditions">
      {/* Section header: title + link */}
      <div className="mb-4 flex items-center justify-between">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-5 w-24" />
      </div>
      {/* 2×3 grid of metric cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 sm:gap-5">
        {Array.from({ length: 6 }).map((_, i) => (
          <MetricCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sun Times skeleton
// Matches: card > heading, 3 flex items (sunrise, sunset, daylight)
// ---------------------------------------------------------------------------

export function SunTimesSkeleton() {
  return (
    <div
      className="rounded-[var(--radius-card)] border border-primary/25 bg-surface-card p-5 shadow-sm sm:p-6"
      role="status"
      aria-label="Loading sun times"
    >
      {/* Heading */}
      <Skeleton className="h-6 w-12" />
      {/* 3 sun stat items */}
      <div className="mt-5 flex flex-wrap gap-6 sm:gap-8">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-6 w-6 rounded-full shrink-0" />
            <div className="space-y-1.5">
              <Skeleton className="h-3.5 w-14" />
              <Skeleton className="h-4 w-12" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Map Preview skeleton
// Matches: card > heading + link row, 16:9 aspect map area
// ---------------------------------------------------------------------------

export function MapPreviewSkeleton() {
  return (
    <div
      className="rounded-[var(--radius-card)] border border-primary/25 bg-surface-card shadow-sm overflow-hidden"
      role="status"
      aria-label="Loading weather map"
    >
      {/* Header: heading + link */}
      <div className="flex items-center justify-between p-5 pb-2 sm:px-6">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-5 w-24" />
      </div>
      {/* Map area */}
      <Skeleton className="aspect-[16/9] w-full rounded-none" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Support Banner skeleton
// Matches: card with BMC-style layout — dot + heading, subtitle, badge
// ---------------------------------------------------------------------------

export function SupportBannerSkeleton() {
  return (
    <div
      className="rounded-[var(--radius-card)] border border-text-tertiary/20 bg-surface-card p-0 shadow-sm"
      role="status"
      aria-label="Loading support banner"
    >
      <div className="px-5 py-4">
        {/* Dot + heading */}
        <div className="flex items-center gap-3">
          <Skeleton className="h-3 w-3 shrink-0 rounded-full" />
          <Skeleton className="h-5 w-48" />
        </div>
        {/* Subtitle */}
        <Skeleton className="mt-2 h-4 w-72 max-w-full" />
        {/* Badge */}
        <Skeleton className="mt-3 h-8 w-40 rounded-[var(--radius-badge)]" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Location Info skeleton
// Matches: card with heading + 4 info rows (province, elevation, coords, season)
// ---------------------------------------------------------------------------

export function LocationInfoSkeleton() {
  return (
    <div
      className="rounded-[var(--radius-card)] border border-primary/25 bg-surface-card p-5 shadow-sm sm:p-6"
      role="status"
      aria-label="Loading location information"
    >
      {/* Heading */}
      <Skeleton className="h-6 w-36" />
      {/* 4 info rows */}
      <div className="mt-5 space-y-3.5">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center justify-between">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-28" />
          </div>
        ))}
      </div>
    </div>
  );
}
