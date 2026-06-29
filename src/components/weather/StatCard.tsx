export function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="baobab" role="group" aria-label={label}>
      <p className="text-base text-text-tertiary">{label}</p>
      <p className="mt-1.5 text-lg font-semibold text-text-primary font-mono" aria-live="polite">{value}</p>
    </div>
  );
}
