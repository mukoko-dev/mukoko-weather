import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { getCountryWithStats, getProvincesWithLocationCounts } from "@/lib/db";
import { getFlagEmoji, COUNTRIES } from "@/lib/countries";
import { logError } from "@/lib/observability";

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
  };
}

export default async function CountryDetailPage({ params }: Props) {
  const { code } = await params;
  const upperCode = code.toUpperCase();

  // Reject obviously invalid codes early — valid ISO 3166-1 alpha-2 are exactly 2 letters
  if (!/^[A-Z]{2}$/.test(upperCode)) notFound();

  let country: Awaited<ReturnType<typeof getCountryWithStats>> = null;
  let provinces: Awaited<ReturnType<typeof getProvincesWithLocationCounts>> = [];

  try {
    [country, provinces] = await Promise.all([
      loadCountry(upperCode),
      getProvincesWithLocationCounts(upperCode),
    ]);
  } catch (err) {
    logError({
      source: "mongodb",
      severity: "high",
      message: "Failed to load country detail page",
      error: err,
      meta: { code: upperCode },
    });
    // Re-throw at request time so Next.js routes to error.tsx instead of a silent 404.
    // During build-time static generation (MONGODB_URI absent), fall through to notFound()
    // so the build succeeds and ISR handles the route on first real request.
    if (process.env.MONGODB_URI) throw err;
  }

  // DB succeeded but the country doesn't exist — genuine 404.
  if (!country) notFound();

  const flag = getFlagEmoji(upperCode);

  return (
    <>
      <Header />

      <nav aria-label="Breadcrumb" className="mx-auto max-w-5xl px-4 pt-4 sm:px-6 md:px-8">
        <ol className="flex items-center gap-1 text-xs text-text-tertiary">
          <li>
            <Link href="/" className="hover:text-text-secondary transition-colors">Home</Link>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <Link href="/explore" className="hover:text-text-secondary transition-colors">Explore</Link>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <Link href="/explore/country" className="hover:text-text-secondary transition-colors">Countries</Link>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page">
            <span className="font-medium text-text-primary">{country.name}</span>
          </li>
        </ol>
      </nav>

      <main
        id="main-content"
        className="mx-auto max-w-5xl overflow-x-hidden px-4 py-8 pb-24 sm:px-6 sm:pb-8 md:px-8"
      >
        <div className="flex items-center gap-3">
          <span className="text-4xl" aria-hidden="true">{flag}</span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary font-heading sm:text-3xl">
              {country.name}
            </h1>
            <p className="text-sm text-text-secondary">
              {country.region} &bull; {country.locationCount} location{country.locationCount !== 1 ? "s" : ""}
            </p>
          </div>
        </div>

        {provinces.filter((p) => p.locationCount > 0).length === 0 ? (
          <div className="mt-8 rounded-[var(--radius-card)] bg-surface-card p-6 text-center text-text-tertiary">
            <p>No provinces found. Run database initialisation to populate data.</p>
          </div>
        ) : (
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {provinces.map((province) => {
              if (province.locationCount === 0) return null;
              return (
                <Link
                  key={province.slug}
                  href={`/explore/country/${code.toLowerCase()}/${province.slug}`}
                  className="group rounded-[var(--radius-card)] bg-surface-card p-5 shadow-sm transition-all hover:shadow-md hover:bg-surface-card/80 focus-visible:outline-2 focus-visible:outline-primary"
                >
                  <div className="flex items-start justify-between">
                    <h2 className="text-base font-semibold text-text-primary font-heading group-hover:text-primary transition-colors">
                      {province.name}
                    </h2>
                    <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary shrink-0 ml-2">
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
