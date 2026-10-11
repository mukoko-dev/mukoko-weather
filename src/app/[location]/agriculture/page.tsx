import { loadLocation } from "../load-location";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSeasonForDate } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { safeJsonLd } from "@/lib/json-ld";
import { SITE_URL } from "@/lib/site";
import { AgricultureDashboard } from "./AgricultureDashboard";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ location: string }>;
}): Promise<Metadata> {
  const { location: slug } = await params;
  const loc = await loadLocation(slug);
  if (!loc) return { title: "Location not found" };

  const title = `${loc.name} Agriculture Weather — Spray, Plant, Soil & Water`;
  const description = `Farm weather for ${loc.name}, ${loc.province}: spraying, planting, harvest and irrigation windows, soil moisture and temperature by depth, rain against evapotranspiration, growing degree days and frost risk.`;

  return {
    title,
    description,
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
    alternates: {
      canonical: `${SITE_URL}/${loc.slug}/agriculture`,
    },
    openGraph: {
      title: `${loc.name} Agriculture | mukoko weather`,
      description: `Spray, plant, harvest and irrigation windows, soil and water balance for ${loc.name}.`,
      url: `${SITE_URL}/${loc.slug}/agriculture`,
      type: "website",
      locale: "en",
      siteName: "mukoko weather",
    },
  };
}

export default async function AgriculturePage({
  params,
}: {
  params: Promise<{ location: string }>;
}) {
  const { location: slug } = await params;
  const location = await loadLocation(slug);
  if (!location) notFound();

  const [season, user] = await Promise.all([
    getSeasonForDate(new Date(), location.country ?? "", location.lat ?? 0),
    getCurrentUser().catch(() => null),
  ]);
  const pageUrl = `${SITE_URL}/${location.slug}/agriculture`;

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "mukoko weather",
        item: SITE_URL,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: `${location.name} Weather`,
        item: `${SITE_URL}/${location.slug}`,
      },
      { "@type": "ListItem", position: 3, name: "Agriculture", item: pageUrl },
    ],
  };

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
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLd([breadcrumbSchema, webPageSchema]),
        }}
      />
      <AgricultureDashboard
        location={location}
        season={season}
        user={user ? { id: user.id, email: user.email ?? null } : null}
      />
    </>
  );
}
