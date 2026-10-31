import { cache } from "react";
import type { Metadata } from "next";
import { trail } from "@/components/layout/Breadcrumb";
import { ExploreCard } from "@/components/explore/ExploreCard";
import { TagPill } from "@/components/explore/TagPill";
import { SITE_URL } from "@/lib/site";
import { notFound } from "next/navigation";
import { PageShell } from "@/components/layout/PageShell";
import {
  getCountryByCode,
  getLocationsByProvince,
  getProvinceBySlug,
} from "@/lib/db";
import { getFlagEmoji, PROVINCES } from "@/lib/countries";

export const revalidate = 3600;

export function generateStaticParams() {
  return PROVINCES.map((p) => ({
    code: p.countryCode.toLowerCase(),
    province: p.slug,
  }));
}

interface Props {
  params: Promise<{ code: string; province: string }>;
}

// Deduplicate DB calls between generateMetadata and the page component.
// Metadata generation may swallow errors (returns null), but page rendering re-throws.
const loadCountry = cache(async (upperCode: string) =>
  getCountryByCode(upperCode).catch(() => null),
);

const loadProvince = cache(async (provinceSlug: string) =>
  getProvinceBySlug(provinceSlug).catch(() => null),
);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { code, province: provinceSlug } = await params;
  const [country, province] = await Promise.all([
    loadCountry(code.toUpperCase()),
    loadProvince(provinceSlug),
  ]);
  const countryName = country?.name ?? code.toUpperCase();
  const provinceName = province?.name ?? provinceSlug;
  const flag = getFlagEmoji(code.toUpperCase());
  return {
    title: `${flag} ${provinceName}, ${countryName} Weather | mukoko weather`,
    description: `Browse weather forecasts for locations in ${provinceName}, ${countryName}.`,
    alternates: {
      canonical: `${SITE_URL}/explore/country/${code.toLowerCase()}/${provinceSlug}`,
    },
  };
}

export default async function ProvinceDetailPage({ params }: Props) {
  const { code, province: provinceSlug } = await params;
  const upperCode = code.toUpperCase();

  if (!/^[A-Z]{2}$/.test(upperCode)) notFound();

  // These are pure static-array reads (LOCATIONS / COUNTRIES / PROVINCES) — they
  // never throw, so no try/catch is needed.
  const [locations, country, province] = await Promise.all([
    getLocationsByProvince(provinceSlug),
    loadCountry(upperCode),
    loadProvince(provinceSlug),
  ]);
  const countryName = country?.name ?? upperCode;
  // Use the stored province name rather than reconstructing from the slug.
  const provinceName = province?.name ?? provinceSlug;

  // The province has no locations — genuine 404.
  if (locations.length === 0) notFound();

  const flag = getFlagEmoji(upperCode);

  return (
    <PageShell
      width="wide"
      breadcrumb={trail(
        { label: "Explore", href: "/explore" },
        { label: "Countries", href: "/explore/country" },
        {
          label: countryName,
          href: `/explore/country/${code.toLowerCase()}`,
        },
        { label: provinceName },
      )}
    >
      <div className="flex items-center gap-3 mb-1">
        <span className="text-3xl" aria-hidden="true">
          {flag}
        </span>
        <div>
          <h1 className="elephant">{provinceName}</h1>
          <p className="text-base text-text-secondary">
            {countryName} &bull; {locations.length} location
            {locations.length !== 1 ? "s" : ""}
          </p>
        </div>
      </div>

      <div className="herd-grid mt-8">
        {locations.map((loc) => (
          <ExploreCard
            key={loc.slug}
            href={`/${loc.slug}`}
            as="h2"
            title={loc.name}
            meta={
              loc.elevation > 0
                ? `${loc.elevation.toLocaleString()} m elevation`
                : undefined
            }
          >
            <div className="mt-2 flex flex-wrap gap-1">
              {loc.tags.slice(0, 3).map((tag) => (
                <TagPill key={tag}>{tag}</TagPill>
              ))}
            </div>
          </ExploreCard>
        ))}
      </div>
    </PageShell>
  );
}
