import Link from "next/link";
import { getLocationsForContext } from "@/lib/db";
import { Badge } from "@/components/ui/badge";

export default async function LocationNotFound() {
  let locations: { slug: string; name: string }[] = [];
  try {
    locations = await getLocationsForContext(20);
  } catch {
    // MongoDB unavailable — show a minimal 404 without locations list
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <h1 className="font-heading text-4xl font-bold text-text-primary">Location not found</h1>
      <p className="mt-4 text-text-secondary">
        We don&apos;t have weather data for that location yet.
      </p>
      {locations.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-semibold text-text-tertiary">Try one of these cities:</h2>
          <ul className="mt-3 flex flex-wrap gap-2">
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
    </div>
  );
}
