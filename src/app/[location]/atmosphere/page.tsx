import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveLocationParam } from "@/lib/load-location";
import { loadLocationPayload } from "@/lib/location-payload";
import { breadcrumbJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/metadata";
import { JsonLd } from "@/components/layout/JsonLd";
import { AtmosphereDashboard } from "./AtmosphereDashboard";

export const dynamic = "force-dynamic";
export async function generateMetadata({
  params,
}: {
  params: Promise<{ location: string }>;
}): Promise<Metadata> {
  const loc = await resolveLocationParam(params);
  if (!loc) return buildPageMetadata({ notFound: true });

  return buildPageMetadata({
    title: `${loc.name} Atmospheric Conditions — Humidity, Wind, UV & Pressure`,
    description: `24-hour atmospheric trends for ${loc.name}, ${loc.province}. Detailed charts for humidity, cloud cover, wind speed, barometric pressure, and UV index from mukoko weather.`,
    path: `/${loc.slug}/atmosphere`,
    keywords: [
      `${loc.name} humidity`,
      `${loc.name} wind speed`,
      `${loc.name} UV index`,
      `${loc.name} barometric pressure`,
      `${loc.name} atmospheric conditions`,
      `${loc.province} weather`,
      "weather intelligence",
      "mukoko weather",
    ],
    og: {
      title: `${loc.name} Atmosphere | mukoko weather`,
      description: `24-hour atmospheric trends for ${loc.name}, ${loc.province} — humidity, wind, pressure, UV index.`,
    },
  });
}

export default async function AtmospherePage({
  params,
}: {
  params: Promise<{ location: string }>;
}) {
  const location = await resolveLocationParam(params);
  if (!location) notFound();

  const { weather, usingFallback, frostAlert, season } =
    await loadLocationPayload(location);

  const breadcrumbSchema = breadcrumbJsonLd([
    { name: `${location.name} Weather`, path: `/${location.slug}` },
    { name: "Atmosphere", path: `/${location.slug}/atmosphere` },
  ]);

  return (
    <>
      <JsonLd data={[breadcrumbSchema]} />
      <AtmosphereDashboard
        weather={weather}
        location={location}
        usingFallback={usingFallback}
        frostAlert={frostAlert}
        season={season}
      />
    </>
  );
}
