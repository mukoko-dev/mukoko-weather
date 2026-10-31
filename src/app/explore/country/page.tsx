import type { Metadata } from "next";
import { PageShell } from "@/components/layout/PageShell";
import { PageHeader } from "@/components/layout/PageHeader";
import { trail } from "@/components/layout/Breadcrumb";
import { ExploreCard } from "@/components/explore/ExploreCard";
import { getAllCountries } from "@/lib/db";
import { getFlagEmoji } from "@/lib/countries";
import { logError } from "@/lib/observability";
import type { CountryDoc } from "@/lib/db";
import { SITE_URL } from "@/lib/site";

export const revalidate = 3600;
export const metadata: Metadata = {
  title: "Browse Weather by Country | mukoko weather",
  description:
    "Explore weather forecasts worldwide — browse by country and region.",
  alternates: {
    canonical: `${SITE_URL}/explore/country`,
  },
  openGraph: {
    title: "Browse Weather by Country | mukoko weather",
    description:
      "Explore weather forecasts worldwide — browse by country and region.",
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
    <PageShell
      width="wide"
      breadcrumb={trail(
        { label: "Explore", href: "/explore" },
        { label: "Countries" },
      )}
    >
      <PageHeader
        title="Browse by Country"
        intro={
          countries.length > 0
            ? `${countries.length} countries worldwide`
            : "No countries available yet — check back soon."
        }
      />

      {sortedRegions.map((region) => (
        <section
          key={region}
          aria-labelledby={`region-${region.replace(/\s+/g, "-").toLowerCase()}`}
          className="mt-10"
        >
          <h2
            id={`region-${region.replace(/\s+/g, "-").toLowerCase()}`}
            className="eland mb-4 border-b border-border-subtle pb-2"
          >
            {region}
          </h2>
          <div className="herd-grid">
            {byRegion[region].map((country) => (
              <ExploreCard
                key={country.code}
                href={`/explore/country/${country.code.toLowerCase()}`}
                title={
                  <span className="inline-flex items-center gap-3">
                    <span className="text-2xl" aria-hidden="true">
                      {getFlagEmoji(country.code)}
                    </span>
                    {country.name}
                  </span>
                }
              />
            ))}
          </div>
        </section>
      ))}
    </PageShell>
  );
}
