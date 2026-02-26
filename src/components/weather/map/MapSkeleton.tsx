"use client";

export function MapSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={`relative aspect-[16/9] w-full animate-pulse rounded-[var(--radius-card)] bg-surface-card overflow-hidden ${className ?? ""}`}
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
