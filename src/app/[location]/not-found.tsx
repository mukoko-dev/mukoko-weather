import Link from "next/link";
import { LOCATIONS } from "@/lib/locations";

export default function LocationNotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <h1 className="font-display text-4xl font-bold text-text-primary">Location not found</h1>
      <p className="mt-4 text-text-secondary">
        We don&apos;t have weather data for that location yet.
      </p>
      <div className="mt-8">
        <h2 className="text-sm font-semibold text-text-tertiary">Try one of these cities:</h2>
        <ul className="mt-3 flex flex-wrap gap-2">
          {LOCATIONS.map((loc) => (
            <li key={loc.slug}>
              <Link
                href={`/${loc.slug}`}
                className="inline-block rounded-[var(--radius-badge)] bg-primary/10 px-3 py-1 text-sm font-medium text-primary transition-colors hover:bg-primary/20"
              >
                {loc.name}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
