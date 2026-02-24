export function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-primary/25 bg-surface-card p-4 shadow-sm" role="group" aria-label={label}>
      <p className="text-xs text-text-tertiary">{label}</p>
      <p className="mt-1.5 text-lg font-semibold text-text-primary font-mono" aria-live="polite">{value}</p>
    </div>
  );
}
