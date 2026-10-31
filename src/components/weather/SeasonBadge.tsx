import type { Season } from "@/lib/weather";
import { Badge } from "@/components/ui/badge";

interface SeasonBadgeProps {
  season: Season;
}

/**
 * The season line at the foot of the hero. It wraps instead of truncating, so
 * a larger text size never cuts the description off (Dynamic Type).
 */
export function SeasonBadge({ season }: SeasonBadgeProps) {
  const showLocalName = season.localName && season.localName !== season.name;
  return (
    <Badge className="max-w-full flex-wrap justify-center gap-x-2 px-3 py-1 text-center">
      <span className="text-base font-semibold">
        {showLocalName ? season.localName : season.name}
      </span>
      <span className="text-base font-normal text-text-secondary">
        {showLocalName
          ? `${season.name} — ${season.description}`
          : season.description}
      </span>
    </Badge>
  );
}
