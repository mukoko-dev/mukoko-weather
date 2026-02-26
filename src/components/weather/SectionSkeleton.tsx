export function SectionSkeleton({ className }: { className?: string } = {}) {
  return (
    <div className={`animate-pulse rounded-[var(--radius-card)] bg-surface-card ${className ?? "h-32"}`} role="status" aria-label="Loading section">
      <span className="sr-only">Loading section</span>
    </div>
  );
}
