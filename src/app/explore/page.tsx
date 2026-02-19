import { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { getTagCounts, getAllLocationsFromDb, getFeaturedTagsFromDb } from "@/lib/db";
import { logError } from "@/lib/observability";
import type { TagDoc } from "@/lib/db";

// Cache for 1 hour; regenerates in the background after expiry (ISR).
// Location data changes rarely — this eliminates cold-start DB latency for visitors.
export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Explore Zimbabwe Weather | mukoko weather",
  description:
    "Browse weather conditions across Zimbabwe by category — cities, farming regions, mining areas, national parks, tourism sites, border posts, and more.",
  openGraph: {
    title: "Explore Zimbabwe Weather | mukoko weather",
    description:
      "Browse weather conditions across Zimbabwe by category — cities, farming regions, mining areas, national parks, tourism sites, border posts, and more.",
  },
};

export default async function ExplorePage() {
  let tagCounts: { tag: string; count: number }[] = [];
  let totalLocations = 0;
  let featuredTags: TagDoc[] = [];

  try {
    const [tags, locations, dbTags] = await Promise.all([
      getTagCounts(),
      getAllLocationsFromDb(),
      getFeaturedTagsFromDb(),
    ]);
    tagCounts = tags;
    totalLocations = locations.length;
    featuredTags = dbTags;
  } catch (err) {
    logError({
      source: "mongodb",
      severity: "high",
      message: "Failed to load explore page data",
      error: err,
    });
  }

  // Build a lookup map from DB tags for O(1) access
  const tagMeta = new Map(featuredTags.map((t) => [t.slug, t]));

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
          <li aria-current="page">
            <span className="font-medium text-text-primary">Explore</span>
          </li>
        </ol>
      </nav>

      <main id="main-content" className="mx-auto max-w-5xl overflow-x-hidden px-4 py-6 pb-24 sm:px-6 sm:pb-6 md:px-8">
        <h1 className="text-2xl font-bold text-text-primary font-heading sm:text-3xl">
          Explore Zimbabwe Weather
        </h1>
        <p className="mt-2 text-text-secondary">
          Browse weather conditions across {totalLocations || "90+"} locations by category.
        </p>

        {tagCounts.length === 0 && (
          <div className="mt-8 rounded-[var(--radius-card)] bg-surface-card p-6 text-center text-text-tertiary">
            <p>Location data is loading. Please run database initialisation first.</p>
          </div>
        )}

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {tagCounts.map(({ tag, count }) => {
            const meta = tagMeta.get(tag);
            if (!meta) return null;

            return (
              <Link
                key={tag}
                href={`/explore/${tag}`}
                className="group rounded-[var(--radius-card)] bg-surface-card p-5 shadow-sm transition-all hover:shadow-md hover:bg-surface-card/80 focus-visible:outline-2 focus-visible:outline-primary"
              >
                <div className="flex items-start justify-between">
                  <h2 className="text-lg font-semibold text-text-primary font-heading group-hover:text-primary transition-colors">
                    {meta.label}
                  </h2>
                  <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                    {count}
                  </span>
                </div>
                <p className="mt-1 text-sm text-text-secondary">
                  {meta.description}
                </p>
              </Link>
            );
          })}
        </div>

        {/* Country browse card */}
        <div className="mt-8 rounded-[var(--radius-card)] bg-surface-card p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-text-primary font-heading">Browse by Country</h2>
              <p className="mt-1 text-sm text-text-secondary">
                Explore weather across Africa and ASEAN — grouped by country and province
              </p>
            </div>
            <Link
              href="/explore/country"
              className="shrink-0 ml-4 inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors focus-visible:outline-2 focus-visible:outline-primary"
            >
              Browse countries
            </Link>
          </div>
        </div>

        {/* All locations link */}
        <div className="mt-6 text-center">
          <Link
            href="/explore/city"
            className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:text-primary/80 transition-colors"
          >
            Browse all cities and towns
          </Link>
        </div>
      </main>

      <Footer />
    </>
  );
}
