import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { checkFrostRisk, createFallbackWeather } from "@/lib/weather";
import { getWeatherForLocation, getLocationFromDb, getSeasonForDate } from "@/lib/db";
import { ForecastDashboard } from "./ForecastDashboard";

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

  const title = `${loc.name} 7-Day Forecast — Hourly & Daily Weather`;
  const description = `Detailed 7-day weather forecast and 24-hour hourly predictions for ${loc.name}, ${loc.province}, Zimbabwe. Temperature charts, rain probability, sunrise/sunset times from mukoko weather.`;

  return {
    title,
    description,
    keywords: [
      `${loc.name} forecast`,
      `${loc.name} 7 day forecast`,
      `${loc.name} hourly forecast`,
      `${loc.name} rain forecast`,
      `${loc.name} temperature forecast`,
      `${loc.province} weather forecast`,
      "Zimbabwe weather forecast",
      "mukoko weather",
    ],
    alternates: {
      canonical: `${BASE_URL}/${loc.slug}/forecast`,
    },
    openGraph: {
      title: `${loc.name} Forecast | mukoko weather`,
      description: `7-day weather forecast for ${loc.name}, Zimbabwe — hourly & daily predictions with charts.`,
      url: `${BASE_URL}/${loc.slug}/forecast`,
      type: "website",
      locale: "en_ZW",
      siteName: "mukoko weather",
    },
  };
}

export default async function ForecastPage({
  params,
}: {
  params: Promise<{ location: string }>;
}) {
  const { location: slug } = await params;
  const location = await getLocationFromDb(slug);
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
  const season = await getSeasonForDate(new Date(), location.country ?? "ZW");

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "mukoko weather", item: BASE_URL },
      { "@type": "ListItem", position: 2, name: `${location.name} Weather`, item: `${BASE_URL}/${location.slug}` },
      { "@type": "ListItem", position: 3, name: "Forecast", item: `${BASE_URL}/${location.slug}/forecast` },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema]) }}
      />
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
