import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { locationPath } from "@/lib/slug-migration";

/**
 * "Try one of these cities": the way out of a place we could not show. One
 * list for the server's not-found page (`LocationNotFound`) and the one the
 * browser shows when it could not resolve a slug (`PlaceNotFound`). Renders
 * nothing for an empty list. No hooks, so either side can render it.
 */
export function CitySuggestions({
  locations,
}: {
  locations: readonly { slug: string; name: string }[];
}) {
  if (locations.length === 0) return null;
  return (
    <div className="mt-8">
      <h2 className="text-base font-semibold text-text-tertiary">
        Try one of these cities:
      </h2>
      <ul className="mt-3 flex flex-wrap justify-center gap-2">
        {locations.map((loc) => (
          <li key={loc.slug}>
            <Link href={locationPath(loc.slug)}>
              <Badge className="hover:bg-primary/20 transition-colors">
                {loc.name}
              </Badge>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
