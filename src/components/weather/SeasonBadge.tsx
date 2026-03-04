import type { Season } from "@/lib/weather";
import { Badge } from "@/components/ui/badge";

interface SeasonBadgeProps {
  season: Season;
}

export function SeasonBadge({ season }: SeasonBadgeProps) {
  const showLocalName = season.localName && season.localName !== season.name;
  return (
    <Badge className="max-w-full gap-2 px-3 py-1">
      <span className="shrink-0 text-base font-semibold">
        {showLocalName ? season.localName : season.name}
      </span>
      <span className="truncate text-base font-normal text-text-secondary">
        {showLocalName ? `${season.name} — ${season.description}` : season.description}
      </span>
    </Badge>
  );
}
