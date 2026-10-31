import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveLocationParam } from "@/lib/load-location";
import { getCachedSeason } from "@/lib/location-payload";
import { getCurrentUser } from "@/lib/auth";
import { breadcrumbJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/metadata";
import { SITE_URL } from "@/lib/site";
import { JsonLd } from "@/components/layout/JsonLd";
import { AgricultureDashboard } from "./AgricultureDashboard";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ location: string }>;
}): Promise<Metadata> {
  const loc = await resolveLocationParam(params);
  if (!loc) return buildPageMetadata({ notFound: true });

  return buildPageMetadata({
    title: `${loc.name} Agriculture Weather — Spray, Plant, Soil & Water`,
    description: `Farm weather for ${loc.name}, ${loc.province}: spraying, planting, harvest and irrigation windows, soil moisture and temperature by depth, rain against evapotranspiration, growing degree days and frost risk.`,
    path: `/${loc.slug}/agriculture`,
    keywords: [
      `${loc.name} farming weather`,
      `${loc.name} planting rains`,
      `${loc.name} soil moisture`,
      `${loc.name} spraying conditions`,
      `${loc.province} agriculture`,
      "growing degree days",
      "evapotranspiration",
      "mukoko weather",
    ],
    og: {
      title: `${loc.name} Agriculture | mukoko weather`,
      description: `Spray, plant, harvest and irrigation windows, soil and water balance for ${loc.name}.`,
    },
  });
}

export default async function AgriculturePage({
  params,
}: {
  params: Promise<{ location: string }>;
}) {
  const location = await resolveLocationParam(params);
  if (!location) notFound();

  const [season, user] = await Promise.all([
    getCachedSeason(location.country ?? "", location.lat ?? 0),
    getCurrentUser().catch(() => null),
  ]);
  const pageUrl = `${SITE_URL}/${location.slug}/agriculture`;

  const breadcrumbSchema = breadcrumbJsonLd([
    { name: `${location.name} Weather`, path: `/${location.slug}` },
    { name: "Agriculture", path: `/${location.slug}/agriculture` },
  ]);

  const webPageSchema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `${location.name} agriculture weather`,
    url: pageUrl,
    about: {
      "@type": "Place",
      name: location.name,
      geo: {
        "@type": "GeoCoordinates",
        latitude: location.lat,
        longitude: location.lon,
        elevation: {
          "@type": "QuantitativeValue",
          value: location.elevation,
          unitCode: "MTR",
        },
      },
      address: {
        "@type": "PostalAddress",
        addressRegion: location.province,
        ...(location.country ? { addressCountry: location.country } : {}),
      },
    },
  };

  return (
    <>
      <JsonLd data={[breadcrumbSchema, webPageSchema]} />
      <AgricultureDashboard
        location={location}
        season={season}
        user={user ? { id: user.id, email: user.email ?? null } : null}
      />
    </>
  );
}
