import { cache } from "react";
import type { Metadata } from "next";
import { trail } from "@/components/layout/Breadcrumb";
import { ExploreCard } from "@/components/explore/ExploreCard";
import { CountPill } from "@/components/explore/CountPill";
import { SITE_URL } from "@/lib/site";
import { notFound } from "next/navigation";
import { PageShell } from "@/components/layout/PageShell";
import { EmptyState } from "@/components/ui/empty-state";
import { getCountryWithStats, getProvincesWithLocationCounts } from "@/lib/db";
import { getFlagEmoji, COUNTRIES } from "@/lib/countries";

export const revalidate = 3600;

export function generateStaticParams() {
  return COUNTRIES.map((c) => ({ code: c.code.toLowerCase() }));
}

interface Props {
  params: Promise<{ code: string }>;
}

// Deduplicate DB calls between generateMetadata and the page component.
// Metadata generation may swallow errors (returns null), but page rendering re-throws.
const loadCountry = cache(async (upperCode: string) =>
  getCountryWithStats(upperCode).catch(() => null),
);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { code } = await params;
  const country = await loadCountry(code.toUpperCase());
  const name = country?.name ?? code.toUpperCase();
  const flag = getFlagEmoji(code.toUpperCase());
  return {
    title: `${flag} ${name} Weather | mukoko weather`,
    description: `Browse weather forecasts across provinces and cities in ${name}.`,
    alternates: {
      canonical: `${SITE_URL}/explore/country/${code.toLowerCase()}`,
    },
  };
}

export default async function CountryDetailPage({ params }: Props) {
  const { code } = await params;
  const upperCode = code.toUpperCase();

  // Reject obviously invalid codes early — valid ISO 3166-1 alpha-2 are exactly 2 letters
  if (!/^[A-Z]{2}$/.test(upperCode)) notFound();

  // These are pure static-array reads (LOCATIONS / COUNTRIES / PROVINCES) — they
  // never throw, so no try/catch is needed.
  const [country, provinces] = await Promise.all([
    loadCountry(upperCode),
    getProvincesWithLocationCounts(upperCode),
  ]);

  // The country doesn't exist — genuine 404.
  if (!country) notFound();

  const flag = getFlagEmoji(upperCode);

  return (
    <PageShell
      width="wide"
      breadcrumb={trail(
        { label: "Explore", href: "/explore" },
        { label: "Countries", href: "/explore/country" },
        { label: country.name },
      )}
    >
      <div className="flex items-center gap-3">
        <span className="text-4xl" aria-hidden="true">
          {flag}
        </span>
        <div>
          <h1 className="elephant">{country.name}</h1>
          <p className="text-base text-text-secondary">
            {country.region} &bull; {country.locationCount} location
            {country.locationCount !== 1 ? "s" : ""}
          </p>
        </div>
      </div>

      {provinces.filter((p) => p.locationCount > 0).length === 0 ? (
        <EmptyState className="mt-8">
          No locations available here yet.
        </EmptyState>
      ) : (
        <div className="herd-grid mt-8">
          {provinces.map((province) => {
            if (province.locationCount === 0) return null;
            return (
              <ExploreCard
                key={province.slug}
                href={`/explore/country/${code.toLowerCase()}/${province.slug}`}
                as="h2"
                title={province.name}
                badge={<CountPill>{province.locationCount}</CountPill>}
              />
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
