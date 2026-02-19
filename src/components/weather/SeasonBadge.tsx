import type { ZimbabweSeason } from "@/lib/weather";
import { Badge } from "@/components/ui/badge";

interface SeasonBadgeProps {
  season: ZimbabweSeason;
}

export function SeasonBadge({ season }: SeasonBadgeProps) {
  return (
    <Badge className="max-w-full gap-2 px-3 py-1">
      <span className="shrink-0 text-sm font-semibold">{season.shona}</span>
      <span className="truncate text-sm font-normal text-text-secondary">
        {season.name} — {season.description}
      </span>
    </Badge>
  );
}
