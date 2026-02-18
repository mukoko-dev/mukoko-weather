import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocationFromDb } from "@/lib/db";
import { MapDashboard } from "./MapDashboard";

export const dynamic = "force-dynamic";

const BASE_URL = "https://weather.mukoko.com";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ location: string }>;
}): Promise<Metadata> {
  const { location: slug } = await params;
  const loc = await getLocationFromDb(slug);
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
      canonical: `${BASE_URL}/${loc.slug}/map`,
    },
    openGraph: {
      title: `${loc.name} Map | mukoko weather`,
      description: `Interactive weather map for ${loc.name} — rain, cloud, temperature, wind, humidity layers.`,
      url: `${BASE_URL}/${loc.slug}/map`,
      type: "website",
      locale: "en_ZW",
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
  const location = await getLocationFromDb(slug);
  if (!location) notFound();

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "mukoko weather", item: BASE_URL },
      { "@type": "ListItem", position: 2, name: `${location.name} Weather`, item: `${BASE_URL}/${location.slug}` },
      { "@type": "ListItem", position: 3, name: "Map", item: `${BASE_URL}/${location.slug}/map` },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema]) }}
      />
      <MapDashboard location={location} />
    </>
  );
}
