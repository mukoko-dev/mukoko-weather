import "@/app/globals.css";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveLocationParam } from "@/lib/load-location";
import { seasonWithinBudget } from "@/lib/place-seed-server";
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

/**
 * The atmosphere page: the shell, the place and its structured data. It makes
 * NO weather call (issue #452, the rule of #414): the forecast is fetched by
 * the visitor's own browser and painted over the copy stored on the device,
 * so the first byte never waits on the Worker or Open-Meteo.
 *
 * The only data it still waits for is the place (the lookup the layout shares)
 * and the season, which has an 800 ms budget and then falls back to the
 * hemisphere's default.
 */
export default async function AtmospherePage({
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
    { name: "Atmosphere", path: `/${location.slug}/atmosphere` },
  ]);

  return (
    <>
      <JsonLd data={[breadcrumbSchema]} />
      <AtmosphereDashboard
        key={location.slug}
        location={location}
        season={season}
      />
    </>
  );
}
