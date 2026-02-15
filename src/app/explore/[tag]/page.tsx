import { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { getLocationsByTagFromDb } from "@/lib/db";
import { logError } from "@/lib/observability";
import type { LocationDoc } from "@/lib/db";

const VALID_TAGS: Record<string, { label: string; description: string }> = {
  city: {
    label: "Cities & Towns",
    description: "Weather for major urban centres across Zimbabwe",
  },
  farming: {
    label: "Farming Regions",
    description: "Weather for agricultural areas — critical for crop planning, irrigation, and harvest timing",
  },
  mining: {
    label: "Mining Areas",
    description: "Weather for mining operations — heat stress, dust conditions, and access road safety",
  },
  tourism: {
    label: "Tourism & Heritage Sites",
    description: "Weather for national parks, UNESCO sites, and natural wonders",
  },
  "national-park": {
    label: "National Parks",
    description: "Weather for protected wildlife and wilderness areas — safari planning and trail conditions",
  },
  education: {
    label: "Education Centres",
    description: "Weather for university towns and mission school areas",
  },
  border: {
    label: "Border Posts",
    description: "Weather at international border crossings — important for cross-border travel planning",
  },
  travel: {
    label: "Travel Corridors",
    description: "Weather along key transit routes and stopover points across Zimbabwe",
  },
};

interface Props {
  params: Promise<{ tag: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { tag } = await params;
  const meta = VALID_TAGS[tag];

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
  const meta = VALID_TAGS[tag];

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

      <nav aria-label="Breadcrumb" className="mx-auto max-w-5xl px-4 pt-4 sm:pl-6 md:pl-8">
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

      <main id="main-content" className="mx-auto max-w-5xl px-4 py-6 sm:pl-6 md:pl-8">
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
                    className="group flex items-center justify-between rounded-[var(--radius-card)] bg-surface-card px-4 py-3 shadow-sm transition-all hover:shadow-md hover:bg-surface-card/80 focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    <div className="min-w-0">
                      <span className="block font-medium text-text-primary group-hover:text-primary transition-colors truncate">
                        {loc.name}
                      </span>
                      <span className="text-xs text-text-tertiary">
                        {loc.elevation}m elevation
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1 ml-2">
                      {loc.tags
                        .filter((t) => t !== tag)
                        .slice(0, 2)
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
