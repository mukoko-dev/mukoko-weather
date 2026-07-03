"use client";

/**
 * Map loading placeholder. Defaults to a 16:9 card (matches the compact
 * MapPreview). Pass `fill` for full-height contexts (the full-viewport map
 * dashboard) so the skeleton box matches the final map and there's no layout
 * shift when the real map mounts.
 */
export function MapSkeleton({
  className,
  fill = false,
}: {
  className?: string;
  fill?: boolean;
}) {
  return (
    <div
      className={`relative ${fill ? "h-full w-full" : "aspect-[16/9] w-full"} animate-pulse rounded-[var(--radius-card)] bg-surface-card overflow-hidden ${className ?? ""}`}
      role="status"
      aria-label="Loading map"
    >
      {/* Simulated map grid */}
      <div className="absolute inset-0 grid grid-cols-4 grid-rows-3 gap-px opacity-[0.04]">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="bg-text-primary" />
        ))}
      </div>
      {/* Center pin placeholder */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
        <div className="h-8 w-8 rounded-full bg-primary/20" />
      </div>
      <span className="sr-only">Loading map</span>
    </div>
  );
}
