import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { getAllCountries } from "@/lib/db";
import { getFlagEmoji } from "@/lib/countries";
import { logError } from "@/lib/observability";
import type { CountryDoc } from "@/lib/db";

export const revalidate = 3600;

const BASE_URL = "https://weather.mukoko.com";

export const metadata: Metadata = {
  title: "Browse Weather by Country | mukoko weather",
  description:
    "Explore weather forecasts across the developing world — browse by country and region.",
  alternates: {
    canonical: `${BASE_URL}/explore/country`,
  },
  openGraph: {
    title: "Browse Weather by Country | mukoko weather",
    description:
      "Explore weather forecasts across the developing world — browse by country and region.",
  },
};

export default async function ExploreCountryPage() {
  let countries: CountryDoc[] = [];

  try {
    countries = await getAllCountries();
  } catch (err) {
    logError({
      source: "mongodb",
      severity: "high",
      message: "Failed to load countries for explore page",
      error: err,
    });
  }

  // Group by region
  const byRegion: Record<string, CountryDoc[]> = {};
  for (const country of countries) {
    if (!byRegion[country.region]) byRegion[country.region] = [];
    byRegion[country.region].push(country);
  }

  const regionOrder = [
    "Southern Africa",
    "East Africa",
    "West Africa",
    "Central Africa",
    "North Africa",
    "ASEAN",
    "Indian Ocean",
    "Unknown",
  ];

  const sortedRegions = Object.keys(byRegion).sort(
    (a, b) => regionOrder.indexOf(a) - regionOrder.indexOf(b),
  );

  return (
    <>
      <Header />

      <nav aria-label="Breadcrumb" className="mx-auto max-w-5xl px-4 pt-4 sm:px-6 md:px-8">
        <ol className="flex items-center gap-1 text-base text-text-tertiary">
          <li>
            <Link href="/" className="hover:text-text-secondary transition-colors">Home</Link>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <Link href="/explore" className="hover:text-text-secondary transition-colors">Explore</Link>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page">
            <span className="font-medium text-text-primary">Countries</span>
          </li>
        </ol>
      </nav>

      {/* pb-24 reserves space on mobile for a future sticky bottom nav bar;
          sm:pb-8 restores normal padding on larger screens. */}
      <main
        id="main-content"
        className="mx-auto max-w-5xl overflow-x-hidden px-4 py-8 pb-24 sm:px-6 sm:pb-8 md:px-8"
      >
        <h1 className="text-2xl font-bold text-text-primary font-heading sm:text-3xl">
          Browse by Country
        </h1>
        <p className="mt-2 text-text-secondary">
          {countries.length > 0
            ? `${countries.length} countries across the developing world`
            : "No countries available yet — check back soon."}
        </p>

        {sortedRegions.map((region) => (
          <section key={region} aria-labelledby={`region-${region.replace(/\s+/g, "-").toLowerCase()}`} className="mt-10">
            <h2
              id={`region-${region.replace(/\s+/g, "-").toLowerCase()}`}
              className="text-lg font-semibold text-text-primary font-heading mb-4 border-b border-border-subtle pb-2"
            >
              {region}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {byRegion[region].map((country) => (
                <Link
                  key={country.code}
                  href={`/explore/country/${country.code.toLowerCase()}`}
                  className="group flex items-center gap-3 rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm transition-all hover:shadow-md hover:bg-surface-card/80 focus-visible:outline-2 focus-visible:outline-primary"
                >
                  <span className="text-2xl" aria-hidden="true">
                    {getFlagEmoji(country.code)}
                  </span>
                  <span className="font-medium text-text-primary group-hover:text-primary transition-colors">
                    {country.name}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </main>

      <Footer />
    </>
  );
}
