import { getZimbabweSeason } from "@/lib/weather";

export function SeasonBadge() {
  const season = getZimbabweSeason();

  return (
    <div className="inline-flex items-center gap-2 rounded-[var(--radius-badge)] bg-primary/10 px-3 py-1">
      <span className="text-xs font-semibold text-primary">{season.shona}</span>
      <span className="text-xs text-text-secondary">
        {season.name} — {season.description}
      </span>
    </div>
  );
}
