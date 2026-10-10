import { loadLocation } from "../load-location";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { checkFrostRisk, createFallbackWeather } from "@/lib/weather";
import { getWeatherForLocation, getSeasonForDate } from "@/lib/db";
import { safeJsonLd } from "@/lib/json-ld";
import { AtmosphereDashboard } from "./AtmosphereDashboard";
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

  const title = `${loc.name} Atmospheric Conditions — Humidity, Wind, UV & Pressure`;
  const description = `24-hour atmospheric trends for ${loc.name}, ${loc.province}. Detailed charts for humidity, cloud cover, wind speed, barometric pressure, and UV index from mukoko weather.`;

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
      "weather intelligence",
      "mukoko weather",
    ],
    alternates: {
      canonical: `${SITE_URL}/${loc.slug}/atmosphere`,
    },
    openGraph: {
      title: `${loc.name} Atmosphere | mukoko weather`,
      description: `24-hour atmospheric trends for ${loc.name}, ${loc.province} — humidity, wind, pressure, UV index.`,
      url: `${SITE_URL}/${loc.slug}/atmosphere`,
      type: "website",
      locale: "en",
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
  const location = await loadLocation(slug);
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
    weather = createFallbackWeather(
      location.lat,
      location.lon,
      location.elevation,
    );
    weatherSource = "fallback";
  }

  const usingFallback = weatherSource === "fallback";
  const frostAlert = usingFallback
    ? null
    : checkFrostRisk(weather.hourly, weather.utc_offset_seconds);
  const season = await getSeasonForDate(
    new Date(),
    location.country ?? "",
    location.lat ?? 0,
  );

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
        name: "Atmosphere",
        item: `${SITE_URL}/${location.slug}/atmosphere`,
      },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd([breadcrumbSchema]) }}
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
