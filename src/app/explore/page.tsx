import { Suspense } from "react";
import { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { getTagCountsAndStats, getFeaturedTagsFromDb } from "@/lib/db";
import { logError } from "@/lib/observability";
import type { TagDoc } from "@/lib/db";
import { CTACard } from "@/components/ui/cta-card";
import { ExploreSearch } from "@/components/explore/ExploreSearch";

// Cache for 1 hour; regenerates in the background after expiry (ISR).
// Location data changes rarely — this eliminates cold-start DB latency for visitors.
export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Explore Weather | mukoko weather",
  description:
    "Browse weather locations across Africa and ASEAN by category, country, and province. Discover cities, farming regions, national parks, and more.",
  openGraph: {
    title: "Explore Weather | mukoko weather",
    description:
      "Browse weather locations across Africa and ASEAN by category, country, and province. Discover cities, farming regions, national parks, and more.",
  },
};

export default async function ExplorePage() {
  let tagCounts: { tag: string; count: number }[] = [];
  let totalLocations = 0;
  let featuredTags: TagDoc[] = [];

  try {
    // Single $facet aggregation replaces separate getTagCounts + getAllLocationsFromDb calls
    const [stats, dbTags] = await Promise.all([
      getTagCountsAndStats(),
      getFeaturedTagsFromDb(),
    ]);
    tagCounts = stats.tags;
    totalLocations = stats.totalLocations;
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
        <ol className="flex items-center gap-1 text-base text-text-tertiary">
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

      <main id="main-content" className="animate-fade-in mx-auto max-w-5xl overflow-x-hidden px-4 py-8 pb-24 sm:px-6 sm:pb-8 md:px-8">
        <h1 className="text-2xl font-bold text-text-primary font-heading sm:text-3xl">
          Explore
        </h1>
        <p className="mt-3 text-text-secondary">
          Browse weather locations across Africa and ASEAN by category, country, and province.
        </p>

        {/* AI Search */}
        <Suspense fallback={null}>
          <div className="mt-8">
            <ExploreSearch />
          </div>
        </Suspense>

        {/* Shamwari CTA card */}
        <CTACard
          variant="accent"
          as="h2"
          title="Ask Shamwari"
          description="Chat with our AI weather assistant for real-time insights and activity advice"
          action={
            <Link
              href="/shamwari"
              className="press-scale shrink-0 inline-flex items-center gap-2 rounded-[var(--radius-sm)] bg-primary px-4 py-2 text-base font-medium text-primary-foreground hover:bg-primary/90 transition-all focus-visible:outline-2 focus-visible:outline-primary min-h-[44px]"
            >
              Start chatting
            </Link>
          }
          className="mt-6"
        />

        {/* Category browse section */}
        <section aria-labelledby="browse-heading" className="mt-8">
          <h2 id="browse-heading" className="text-xl font-bold text-text-primary font-heading">
            Browse by Category
          </h2>
          <p className="mt-1 text-base text-text-secondary">
            {totalLocations || "90+"} locations across Africa and ASEAN
          </p>

          {tagCounts.length === 0 && (
            <div className="mt-6 rounded-[var(--radius-card)] bg-surface-card p-6 text-center text-text-tertiary">
              <p>Location data is loading. Please run database initialisation first.</p>
            </div>
          )}

          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {tagCounts.map(({ tag, count }) => {
              const meta = tagMeta.get(tag);
              if (!meta) return null;

              return (
                <Link
                  key={tag}
                  href={`/explore/${tag}`}
                  className="group card-interactive rounded-[var(--radius-card)] border border-primary/25 bg-surface-card p-5 shadow-sm focus-visible:outline-2 focus-visible:outline-primary"
                >
                  <div className="flex items-start justify-between">
                    <h3 className="text-base font-semibold text-text-primary font-heading group-hover:text-primary transition-colors">
                      {meta.label}
                    </h3>
                    <span className="rounded-full bg-primary/10 px-2.5 py-1 text-base font-medium text-primary">
                      {count}
                    </span>
                  </div>
                  <p className="mt-2 text-base text-text-secondary line-clamp-2">
                    {meta.description}
                  </p>
                </Link>
              );
            })}
          </div>

          {/* Country browse card */}
          <CTACard
            title="Browse by Country"
            description="Explore weather across Africa and ASEAN — grouped by country and province"
            action={
              <Link
                href="/explore/country"
                className="press-scale shrink-0 inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-primary px-4 py-2 text-base font-medium text-primary-foreground hover:bg-primary/90 transition-all focus-visible:outline-2 focus-visible:outline-primary min-h-[44px]"
              >
                Browse countries
              </Link>
            }
            className="mt-6"
          />
        </section>
      </main>

      <Footer />
    </>
  );
}
