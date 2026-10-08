import { Skeleton } from "@/components/ui/skeleton";

// ---------------------------------------------------------------------------
// Generic section skeleton (backward-compatible default)
// ---------------------------------------------------------------------------

export function SectionSkeleton({ className }: { className?: string } = {}) {
  return (
    <div
      className={`chameleon ${className ?? "h-32"}`}
      role="status"
      aria-label="Loading section"
    />
  );
}

// ---------------------------------------------------------------------------
// Community Reports skeleton
// Matches: heading + button row, then empty-state text line
// ---------------------------------------------------------------------------

export function ReportsSkeleton() {
  return (
    <div
      className="space-y-3"
      role="status"
      aria-label="Loading community reports"
    >
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
      className="baobab p-5 sm:p-6"
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
          <div
            key={i}
            className="flex min-w-[72px] shrink-0 flex-col items-center gap-2.5 rounded-[var(--radius-input)] bg-surface-base px-3.5 py-3.5"
          >
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
            className="baobab flex items-center gap-4 p-5 border-l-[6px] border-l-text-tertiary/20"
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
      className="baobab p-5 sm:p-6"
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
          <div
            key={i}
            className="flex items-center gap-3 rounded-[var(--radius-input)] bg-surface-base px-3.5 py-3.5 min-h-[var(--touch-target-min)] sm:gap-4"
          >
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
      className="baobab border-l-[6px] border-l-tanzanite p-5 sm:p-6"
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
      <div className="flex items-center justify-between px-4 py-3 min-h-[var(--touch-target-min)]">
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
// Map Preview skeleton
// Matches: card > heading + link row, 16:9 aspect map area
// ---------------------------------------------------------------------------

export function MapPreviewSkeleton() {
  return (
    <div
      className="baobab p-0 overflow-hidden"
      role="status"
      aria-label="Loading weather map"
    >
      {/* Header: heading + link */}
      <div className="flex items-center justify-between p-5 pb-2 sm:px-6">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-5 w-24" />
      </div>
      {/* Map area — square, matches MapPreview */}
      <Skeleton className="aspect-square w-full rounded-none" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Air quality (wide) skeleton
// Matches: AQI card under the hero — header, big number, scale bar, sentence
// ---------------------------------------------------------------------------

export function AirQualityWideSkeleton() {
  return (
    <div
      className="chameleon mb-2.5 flex min-w-0 flex-col gap-3 p-4 sm:mb-3"
      role="status"
      aria-label="Loading air quality"
    >
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-10 w-20" />
      <Skeleton className="h-2 w-full rounded-full" />
      <Skeleton className="h-4 w-3/4" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Air quality map skeleton
// Matches: large square AirQualityMapCard (aspect-square, max 28rem)
// ---------------------------------------------------------------------------

export function AirQualityMapSkeleton() {
  return (
    <div
      className="chameleon aspect-square max-h-[28rem] w-full"
      role="status"
      aria-label="Loading air quality map"
    />
  );
}

// ---------------------------------------------------------------------------
// Haze panel skeleton
// Matches: a slim wide strip; HazePanel renders nothing when there is no haze
// ---------------------------------------------------------------------------

export function HazeSkeleton() {
  return (
    <div
      className="chameleon mb-2.5 h-20 w-full sm:mb-3"
      role="status"
      aria-label="Loading haze outlook"
    />
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
      className="baobab p-5 sm:p-6"
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

// ---------------------------------------------------------------------------
// ENSO outlook skeleton
// Matches: card > heading + phase/strength badges, ONI line, impact lines
// ---------------------------------------------------------------------------

export function EnsoOutlookSkeleton() {
  return (
    <div className="baobab p-5 sm:p-6" role="status" aria-label="Loading">
      {/* Heading */}
      <Skeleton className="h-6 w-56" />
      {/* Phase + strength badges */}
      <div className="mt-3 flex gap-2">
        <Skeleton className="h-6 w-20 rounded-[var(--radius-badge)]" />
        <Skeleton className="h-6 w-24 rounded-[var(--radius-badge)]" />
      </div>
      {/* ONI line */}
      <Skeleton className="mt-3 h-4 w-48" />
      {/* Impact lines */}
      <div className="mt-4 space-y-2.5">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    </div>
  );
}
