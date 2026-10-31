import type { Metadata } from "next";
import Link from "next/link";
import { PageShell } from "@/components/layout/PageShell";
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
      breadcrumb={[
        { label: "Home", href: "/" },
        { label: "Explore", href: "/explore" },
        { label: "Countries" },
      ]}
    >
      <h1 className="elephant">Browse by Country</h1>
      <p className="gazelle mt-2">
        {countries.length > 0
          ? `${countries.length} countries worldwide`
          : "No countries available yet — check back soon."}
      </p>

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
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {byRegion[region].map((country) => (
              <Link
                key={country.code}
                href={`/explore/country/${country.code.toLowerCase()}`}
                className="group card-interactive pangolin flex items-center gap-3"
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
    </PageShell>
  );
}
