export function SectionSkeleton() {
  return (
    <div className="h-32 animate-pulse rounded-[var(--radius-card)] bg-surface-card" role="status" aria-label="Loading section">
      <span className="sr-only">Loading section</span>
    </div>
  );
}
