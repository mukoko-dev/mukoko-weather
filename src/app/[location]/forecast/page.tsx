import "@/app/globals.css";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveLocationParam } from "@/lib/load-location";
import { seasonWithinBudget } from "@/lib/place-seed-server";
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

/**
 * The forecast page: the shell, the place and its structured data. It makes NO
 * weather call (issue #452, the rule of #414): the forecast is fetched by the
 * visitor's own browser and painted over the copy stored on the device, so the
 * first byte never waits on the Worker or Open-Meteo.
 *
 * The only data it still waits for is the place (the lookup the layout shares)
 * and the season, which has an 800 ms budget and then falls back to the
 * hemisphere's default.
 */
export default async function ForecastPage({
  params,
}: {
  params: Promise<{ location: string }>;
}) {
  const rawLocation = await resolveLocationParam(params);
  if (!rawLocation) notFound();
  // Strip the store's _id before the place crosses to the client component.
  const { _id: _removed, ...location } = rawLocation as typeof rawLocation & {
    _id?: unknown;
  };
  const season = await seasonWithinBudget(
    (location.country ?? "").toUpperCase(),
    location.lat ?? 0,
  );

  const breadcrumbSchema = breadcrumbJsonLd([
    { name: `${location.name} Weather`, path: `/${location.slug}` },
    { name: "Forecast", path: `/${location.slug}/forecast` },
  ]);

  return (
    <>
      <JsonLd data={[breadcrumbSchema]} />
      <ForecastDashboard
        key={location.slug}
        location={location}
        season={season}
      />
    </>
  );
}
