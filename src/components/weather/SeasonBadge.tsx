import { getZimbabweSeason } from "@/lib/weather";

export function SeasonBadge() {
  const season = getZimbabweSeason();

  return (
    <div className="inline-flex max-w-full items-center gap-2 rounded-[var(--radius-badge)] bg-primary/10 px-3 py-1">
      <span className="shrink-0 text-sm font-semibold text-primary">{season.shona}</span>
      <span className="truncate text-sm text-text-secondary">
        {season.name} — {season.description}
      </span>
    </div>
  );
}
