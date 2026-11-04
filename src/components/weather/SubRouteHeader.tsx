import { SeasonBadge } from "@/components/weather/SeasonBadge";
import type { WeatherLocation } from "@/lib/locations";
import type { Season } from "@/lib/weather";

/**
 * The heading block of `/[location]/forecast` and `/[location]/atmosphere`:
 * the title, the place line and the season badge. Everything in it is known
 * to the server before any weather, so it is part of the first byte and
 * never moves when the forecast arrives.
 *
 * A placeholder height (`elevationApproximate`: a spot, the IP fallback) is
 * left out rather than printed as a measured "0m"; the forecast's own terrain
 * height replaces it once it is known.
 */
export function SubRouteHeader({
  title,
  location,
  season,
}: {
  title: string;
  location: Pick<WeatherLocation, "province" | "elevation"> & {
    elevationApproximate?: boolean;
  };
  season: Season;
}) {
  const line = [
    location.province,
    location.elevationApproximate ? "" : `${location.elevation}m`,
    `${season.localName} (${season.name})`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      <h1 className="elephant">{title}</h1>
      <p className="mt-1 text-base text-text-secondary">{line}</p>

      <div className="mt-4 mb-4">
        <SeasonBadge season={season} />
      </div>
    </>
  );
}
