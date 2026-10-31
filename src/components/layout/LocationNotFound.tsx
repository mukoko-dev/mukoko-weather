// Shared "Location not found" UI — used by the root not-found boundary and
// by `[location]/not-found.tsx`, so an unknown slug looks the same whichever
// boundary catches it. The layout (PageShell, skip-link target, bottom
// clearance) lives in NotFoundView.
import Link from "next/link";
import { getLocationsForContext } from "@/lib/db";
import { Badge } from "@/components/ui/badge";
import { NotFoundView } from "@/components/layout/NotFoundView";

export async function LocationNotFound() {
  let locations: { slug: string; name: string }[] = [];
  try {
    locations = await getLocationsForContext(20);
  } catch {
    // MongoDB unavailable — show a minimal 404 without locations list
  }

  return (
    <NotFoundView
      title="Location not found"
      message="We don't have weather data for that location yet."
      actions={[{ href: "/explore", label: "Browse locations", primary: true }]}
    >
      {locations.length > 0 && (
        <div className="mt-8">
          <h2 className="text-base font-semibold text-text-tertiary">
            Try one of these cities:
          </h2>
          <ul className="mt-3 flex flex-wrap justify-center gap-2">
            {locations.map((loc) => (
              <li key={loc.slug}>
                <Link href={`/${loc.slug}`}>
                  <Badge className="hover:bg-primary/20 transition-colors">
                    {loc.name}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </NotFoundView>
  );
}
