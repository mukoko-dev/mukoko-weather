import { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { getTagCounts, getAllLocationsFromDb } from "@/lib/db";
import { logError } from "@/lib/observability";

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

const TAG_META: Record<string, { label: string; description: string; icon: string }> = {
  city: {
    label: "Cities & Towns",
    description: "Major urban centres across Zimbabwe",
    icon: "building",
  },
  farming: {
    label: "Farming Regions",
    description: "Agricultural areas — tobacco, sugar, cotton, citrus",
    icon: "sprout",
  },
  mining: {
    label: "Mining Areas",
    description: "Gold, platinum, diamond, lithium, and coal operations",
    icon: "pickaxe",
  },
  tourism: {
    label: "Tourism & Heritage",
    description: "National parks, UNESCO sites, natural wonders",
    icon: "camera",
  },
  "national-park": {
    label: "National Parks",
    description: "Protected wildlife and wilderness areas",
    icon: "trees",
  },
  education: {
    label: "Education Centres",
    description: "University towns and mission schools",
    icon: "graduation-cap",
  },
  border: {
    label: "Border Posts",
    description: "International border crossings and ports of entry",
    icon: "flag",
  },
  travel: {
    label: "Travel Corridors",
    description: "Key transit routes and stopover points",
    icon: "route",
  },
};

export default async function ExplorePage() {
  let tagCounts: { tag: string; count: number }[] = [];
  let totalLocations = 0;

  try {
    const [tags, locations] = await Promise.all([
      getTagCounts(),
      getAllLocationsFromDb(),
    ]);
    tagCounts = tags;
    totalLocations = locations.length;
  } catch (err) {
    logError({
      source: "mongodb",
      severity: "high",
      message: "Failed to load explore page data",
      error: err,
    });
  }

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
          <li aria-current="page">
            <span className="font-medium text-text-primary">Explore</span>
          </li>
        </ol>
      </nav>

      <main id="main-content" className="mx-auto max-w-5xl px-4 py-6 sm:pl-6 md:pl-8">
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
            const meta = TAG_META[tag];
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

        {/* All locations link */}
        <div className="mt-8 text-center">
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
