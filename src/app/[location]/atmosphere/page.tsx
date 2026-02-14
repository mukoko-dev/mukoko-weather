import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocationBySlug } from "@/lib/locations";
import { checkFrostRisk, createFallbackWeather, getZimbabweSeason } from "@/lib/weather";
import { getWeatherForLocation } from "@/lib/db";
import { AtmosphereDashboard } from "./AtmosphereDashboard";

export const dynamic = "force-dynamic";

const BASE_URL = "https://weather.mukoko.com";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ location: string }>;
}): Promise<Metadata> {
  const { location: slug } = await params;
  const loc = getLocationBySlug(slug);
  if (!loc) return { title: "Location not found" };

  const title = `${loc.name} Atmospheric Conditions — Humidity, Wind, UV & Pressure`;
  const description = `24-hour atmospheric trends for ${loc.name}, ${loc.province}, Zimbabwe. Detailed charts for humidity, cloud cover, wind speed, barometric pressure, and UV index from mukoko weather.`;

  return {
    title,
    description,
    keywords: [
      `${loc.name} humidity`,
      `${loc.name} wind speed`,
      `${loc.name} UV index`,
      `${loc.name} barometric pressure`,
      `${loc.name} atmospheric conditions`,
      `${loc.province} weather`,
      "Zimbabwe weather",
      "mukoko weather",
    ],
    alternates: {
      canonical: `${BASE_URL}/${loc.slug}/atmosphere`,
    },
    openGraph: {
      title: `${loc.name} Atmosphere | mukoko weather`,
      description: `24-hour atmospheric trends for ${loc.name}, Zimbabwe — humidity, wind, pressure, UV index.`,
      url: `${BASE_URL}/${loc.slug}/atmosphere`,
      type: "website",
      locale: "en_ZW",
      siteName: "mukoko weather",
    },
  };
}

export default async function AtmospherePage({
  params,
}: {
  params: Promise<{ location: string }>;
}) {
  const { location: slug } = await params;
  const location = getLocationBySlug(slug);
  if (!location) notFound();

  let weather;
  let weatherSource: string;
  try {
    const result = await getWeatherForLocation(
      location.slug,
      location.lat,
      location.lon,
      location.elevation,
    );
    weather = result.data;
    weatherSource = result.source;
  } catch {
    weather = createFallbackWeather(location.lat, location.lon, location.elevation);
    weatherSource = "fallback";
  }

  const usingFallback = weatherSource === "fallback";
  const frostAlert = usingFallback ? null : checkFrostRisk(weather.hourly);
  const season = getZimbabweSeason();

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "mukoko weather", item: BASE_URL },
      { "@type": "ListItem", position: 2, name: `${location.name} Weather`, item: `${BASE_URL}/${location.slug}` },
      { "@type": "ListItem", position: 3, name: "Atmosphere", item: `${BASE_URL}/${location.slug}/atmosphere` },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema]) }}
      />
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
