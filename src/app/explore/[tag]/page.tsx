import { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { getLocationsByTagFromDb, getTagBySlug } from "@/lib/db";
import { logError } from "@/lib/observability";
import type { LocationDoc } from "@/lib/db";

// Cache for 1 hour; regenerates in the background after expiry (ISR).
export const revalidate = 3600;

interface Props {
  params: Promise<{ tag: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { tag } = await params;
  const meta = await getTagBySlug(tag).catch(() => null);

  if (!meta) {
    return { title: "Not Found | mukoko weather" };
  }

  return {
    title: `${meta.label} Weather — Zimbabwe | mukoko weather`,
    description: meta.description,
    openGraph: {
      title: `${meta.label} Weather — Zimbabwe | mukoko weather`,
      description: meta.description,
    },
  };
}

export default async function ExploreTagPage({ params }: Props) {
  const { tag } = await params;
  const meta = await getTagBySlug(tag).catch(() => null);

  if (!meta) {
    notFound();
  }

  let locations: LocationDoc[] = [];

  try {
    locations = await getLocationsByTagFromDb(tag);
  } catch (err) {
    logError({
      source: "mongodb",
      severity: "high",
      message: `Failed to load ${tag} locations`,
      error: err,
      location: tag,
    });
  }

  // Group by province for better organisation
  const byProvince = new Map<string, LocationDoc[]>();
  for (const loc of locations) {
    const existing = byProvince.get(loc.province) ?? [];
    existing.push(loc);
    byProvince.set(loc.province, existing);
  }

  // Sort provinces alphabetically
  const provinces = [...byProvince.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  return (
    <>
      <Header />

      <nav aria-label="Breadcrumb" className="mx-auto max-w-5xl px-4 pt-4 sm:px-6 md:px-8">
        <ol className="flex items-center gap-1 text-xs text-text-tertiary">
          <li>
            <Link href="/" className="hover:text-text-secondary transition-colors">
              Home
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <Link href="/explore" className="hover:text-text-secondary transition-colors">
              Explore
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page">
            <span className="font-medium text-text-primary">{meta.label}</span>
          </li>
        </ol>
      </nav>

      <main id="main-content" className="mx-auto max-w-5xl overflow-x-hidden px-4 py-8 pb-24 sm:px-6 sm:pb-8 md:px-8">
        <h1 className="text-2xl font-bold text-text-primary font-heading sm:text-3xl">
          {meta.label}
        </h1>
        <p className="mt-2 text-text-secondary">
          {meta.description}. {locations.length} locations.
        </p>

        {locations.length === 0 && (
          <div className="mt-8 rounded-[var(--radius-card)] bg-surface-card p-6 text-center text-text-tertiary">
            <p>No locations found. Please run database initialisation.</p>
          </div>
        )}

        <div className="mt-8 space-y-8">
          {provinces.map(([province, locs]) => (
            <section key={province} aria-labelledby={`province-${province.toLowerCase().replace(/\s+/g, "-")}`}>
              <h2
                id={`province-${province.toLowerCase().replace(/\s+/g, "-")}`}
                className="text-lg font-semibold text-text-primary font-heading"
              >
                {province}
              </h2>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {locs.sort((a, b) => a.name.localeCompare(b.name)).map((loc) => (
                  <Link
                    key={loc.slug}
                    href={`/${loc.slug}`}
                    className="group flex min-w-0 items-center justify-between rounded-[var(--radius-card)] bg-surface-card px-4 py-3 shadow-sm transition-all hover:bg-surface-card/80 hover:shadow-md focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    <div className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-text-primary transition-colors group-hover:text-primary">
                        {loc.name}
                      </span>
                      <span className="text-xs text-text-tertiary">
                        {loc.elevation}m elevation
                      </span>
                    </div>
                    <div className="ml-2 flex shrink-0 flex-wrap gap-1">
                      {loc.tags
                        .filter((t) => t !== tag)
                        .slice(0, 1)
                        .map((t) => (
                          <span
                            key={t}
                            className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary"
                          >
                            {t}
                          </span>
                        ))}
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>

        {/* Back to explore */}
        <div className="mt-8">
          <Link
            href="/explore"
            className="text-sm font-medium text-primary hover:text-primary/80 transition-colors"
          >
            Back to all categories
          </Link>
        </div>
      </main>

      <Footer />
    </>
  );
}
