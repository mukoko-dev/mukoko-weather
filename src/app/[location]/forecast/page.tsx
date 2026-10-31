import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveLocationParam } from "@/lib/load-location";
import { loadLocationPayload } from "@/lib/location-payload";
import { breadcrumbJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/metadata";
import { JsonLd } from "@/components/layout/JsonLd";
import { ForecastDashboard } from "./ForecastDashboard";

export const dynamic = "force-dynamic";
export async function generateMetadata({
  params,
}: {
  params: Promise<{ location: string }>;
}): Promise<Metadata> {
  const loc = await resolveLocationParam(params);
  if (!loc) return buildPageMetadata({ notFound: true });

  return buildPageMetadata({
    title: `${loc.name} 7-Day Forecast — Hourly & Daily Weather`,
    description: `Detailed 7-day weather forecast and 24-hour hourly predictions for ${loc.name}, ${loc.province}. Temperature charts, rain probability, sunrise/sunset times from mukoko weather.`,
    path: `/${loc.slug}/forecast`,
    keywords: [
      `${loc.name} forecast`,
      `${loc.name} 7 day forecast`,
      `${loc.name} hourly forecast`,
      `${loc.name} rain forecast`,
      `${loc.name} temperature forecast`,
      `${loc.province} weather forecast`,
      "weather forecast",
      "mukoko weather",
    ],
    og: {
      title: `${loc.name} Forecast | mukoko weather`,
      description: `7-day weather forecast for ${loc.name}, ${loc.province} — hourly & daily predictions with charts.`,
    },
  });
}

export default async function ForecastPage({
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
    { name: "Forecast", path: `/${location.slug}/forecast` },
  ]);

  return (
    <>
      <JsonLd data={[breadcrumbSchema]} />
      <ForecastDashboard
        weather={weather}
        location={location}
        usingFallback={usingFallback}
        frostAlert={frostAlert}
        season={season}
      />
    </>
  );
}
