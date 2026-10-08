import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { Breadcrumb } from "@/components/layout/Breadcrumb";
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
      canonical: `https://weather.mukoko.com/explore/country/${code.toLowerCase()}`,
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
    <>
      <Header />

      <Breadcrumb
        items={[
          { label: "Home", href: "/" },
          { label: "Explore", href: "/explore" },
          { label: "Countries", href: "/explore/country" },
          { label: country.name },
        ]}
      />

      <main
        id="main-content"
        className="mx-auto max-w-5xl overflow-x-hidden px-4 py-8 pb-24 sm:px-6 sm:pb-8 md:px-8"
      >
        <div className="flex items-center gap-3">
          <span className="text-4xl" aria-hidden="true">
            {flag}
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary font-heading sm:text-3xl">
              {country.name}
            </h1>
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
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {provinces.map((province) => {
              if (province.locationCount === 0) return null;
              return (
                <Link
                  key={province.slug}
                  href={`/explore/country/${code.toLowerCase()}/${province.slug}`}
                  className="group card-interactive rounded-[var(--radius-card)] bg-surface-card p-5 shadow-sm"
                >
                  <div className="flex items-start justify-between">
                    <h2 className="giraffe group-hover:text-primary transition-colors">
                      {province.name}
                    </h2>
                    <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-base font-medium text-primary shrink-0 ml-2">
                      {province.locationCount}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </main>

      <Footer />
    </>
  );
}
