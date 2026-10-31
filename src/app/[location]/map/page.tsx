import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveLocationParam } from "@/lib/load-location";
import { breadcrumbJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/metadata";
import { JsonLd } from "@/components/layout/JsonLd";
import { MapDashboard } from "./MapDashboard";

export const dynamic = "force-dynamic";
export async function generateMetadata({
  params,
}: {
  params: Promise<{ location: string }>;
}): Promise<Metadata> {
  const loc = await resolveLocationParam(params);
  if (!loc) return buildPageMetadata({ notFound: true });

  return buildPageMetadata({
    title: `${loc.name} Weather Map — Rain, Cloud, Temperature & Wind Layers`,
    description: `Interactive weather map for ${loc.name}, ${loc.province}. View precipitation radar, cloud cover, temperature, wind speed, and humidity layers.`,
    path: `/${loc.slug}/map`,
    keywords: [
      `${loc.name} weather map`,
      `${loc.name} rain radar`,
      `${loc.name} precipitation map`,
      `${loc.province} weather map`,
      "weather map",
      "mukoko weather",
    ],
    og: {
      title: `${loc.name} Map | mukoko weather`,
      description: `Interactive weather map for ${loc.name} — rain, cloud, temperature, wind, humidity layers.`,
    },
  });
}

export default async function MapPage({
  params,
}: {
  params: Promise<{ location: string }>;
}) {
  const location = await resolveLocationParam(params);
  if (!location) notFound();

  const breadcrumbSchema = breadcrumbJsonLd([
    { name: `${location.name} Weather`, path: `/${location.slug}` },
    { name: "Map", path: `/${location.slug}/map` },
  ]);

  return (
    <>
      <JsonLd data={[breadcrumbSchema]} />
      <MapDashboard location={location} />
    </>
  );
}
