import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadLocation } from "../load-location";
import { safeJsonLd } from "@/lib/json-ld";
import { MapDashboard } from "./MapDashboard";
import { SITE_URL } from "@/lib/site";

export const dynamic = "force-dynamic";
export async function generateMetadata({
  params,
}: {
  params: Promise<{ location: string }>;
}): Promise<Metadata> {
  const { location: slug } = await params;
  const loc = await loadLocation(slug);
  if (!loc) return { title: "Location not found" };

  const title = `${loc.name} Weather Map — Rain, Cloud, Temperature & Wind Layers`;
  const description = `Interactive weather map for ${loc.name}, ${loc.province}. View precipitation radar, cloud cover, temperature, wind speed, and humidity layers.`;

  return {
    title,
    description,
    keywords: [
      `${loc.name} weather map`,
      `${loc.name} rain radar`,
      `${loc.name} precipitation map`,
      `${loc.province} weather map`,
      "weather map",
      "mukoko weather",
    ],
    alternates: {
      canonical: `${SITE_URL}/${loc.slug}/map`,
    },
    openGraph: {
      title: `${loc.name} Map | mukoko weather`,
      description: `Interactive weather map for ${loc.name} — rain, cloud, temperature, wind, humidity layers.`,
      url: `${SITE_URL}/${loc.slug}/map`,
      type: "website",
      locale: "en",
      siteName: "mukoko weather",
    },
  };
}

export default async function MapPage({
  params,
}: {
  params: Promise<{ location: string }>;
}) {
  const { location: slug } = await params;
  const location = await loadLocation(slug);
  if (!location) notFound();

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
      {
        "@type": "ListItem",
        position: 3,
        name: "Map",
        item: `${SITE_URL}/${location.slug}/map`,
      },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd([breadcrumbSchema]) }}
      />
      <MapDashboard location={location} />
    </>
  );
}
