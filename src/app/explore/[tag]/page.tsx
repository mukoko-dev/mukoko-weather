import { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageShell } from "@/components/layout/PageShell";
import { PageHeader } from "@/components/layout/PageHeader";
import { trail } from "@/components/layout/Breadcrumb";
import { ExploreCard } from "@/components/explore/ExploreCard";
import { TagPill } from "@/components/explore/TagPill";
import { SITE_URL } from "@/lib/site";
import { EmptyState } from "@/components/ui/empty-state";
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
    title: `${meta.label} Weather Locations | mukoko weather`,
    description: meta.description,
    alternates: {
      canonical: `${SITE_URL}/explore/${tag}`,
    },
    openGraph: {
      title: `${meta.label} Weather Locations | mukoko weather`,
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
    <PageShell
      width="wide"
      breadcrumb={trail(
        { label: "Explore", href: "/explore" },
        { label: meta.label },
      )}
    >
      <PageHeader
        title={meta.label}
        intro={`${meta.description}. ${locations.length} locations.`}
      />

      {locations.length === 0 && (
        <EmptyState className="mt-8">
          No locations available here yet.
        </EmptyState>
      )}

      <div className="mt-8 space-y-8">
        {provinces.map(([province, locs]) => (
          <section
            key={province}
            aria-labelledby={`province-${province.toLowerCase().replace(/\s+/g, "-")}`}
          >
            <h2
              id={`province-${province.toLowerCase().replace(/\s+/g, "-")}`}
              className="eland"
            >
              {province}
            </h2>
            <div className="herd-grid mt-3">
              {locs
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((loc) => (
                  <ExploreCard
                    key={loc.slug}
                    href={`/${loc.slug}`}
                    title={loc.name}
                    meta={`${loc.elevation}m elevation`}
                    badge={loc.tags
                      .filter((t) => t !== tag)
                      .slice(0, 1)
                      .map((t) => (
                        <TagPill key={t}>{t}</TagPill>
                      ))}
                  />
                ))}
            </div>
          </section>
        ))}
      </div>

      {/* Back to explore */}
      <div className="mt-8">
        <Link
          href="/explore"
          className="text-base font-medium text-primary hover:text-primary/80 transition-colors"
        >
          Back to all categories
        </Link>
      </div>
    </PageShell>
  );
}
