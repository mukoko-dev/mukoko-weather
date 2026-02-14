import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocationBySlug } from "@/lib/locations";
import { checkFrostRisk, createFallbackWeather, weatherCodeToInfo } from "@/lib/weather";
import { getWeatherForLocation } from "@/lib/db";
import { WeatherDashboard } from "./WeatherDashboard";

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

  const title = `${loc.name} Weather Today — Forecast & Conditions`;
  const description = `Current weather conditions, 7-day forecast, and hourly predictions for ${loc.name}, ${loc.province}, Zimbabwe. AI-powered weather intelligence with frost alerts, farming insights, and accurate temperature data from mukoko weather.`;

  return {
    title,
    description,
    keywords: [
      `${loc.name} weather`,
      `${loc.name} weather today`,
      `${loc.name} forecast`,
      `${loc.name} temperature`,
      `weather in ${loc.name} Zimbabwe`,
      `${loc.province} weather`,
      `${loc.name} 7 day forecast`,
      `${loc.name} rain forecast`,
      "Zimbabwe weather",
      "mukoko weather",
    ],
    alternates: {
      canonical: `${BASE_URL}/${loc.slug}`,
    },
    openGraph: {
      title: `${loc.name} Weather | mukoko weather`,
      description: `Live weather forecast for ${loc.name}, ${loc.province}, Zimbabwe. Current conditions, 7-day outlook, and AI-powered insights.`,
      url: `${BASE_URL}/${loc.slug}`,
      type: "website",
      locale: "en_ZW",
      siteName: "mukoko weather",
    },
    twitter: {
      card: "summary_large_image",
      title: `${loc.name} Weather | mukoko weather`,
      description: `Live weather for ${loc.name}, Zimbabwe — current conditions, 7-day forecast, and AI insights.`,
    },
  };
}

export default async function LocationPage({
  params,
}: {
  params: Promise<{ location: string }>;
}) {
  const { location: slug } = await params;
  const location = getLocationBySlug(slug);
  if (!location) notFound();

  // Fetch weather — double-caught so the page shell ALWAYS renders.
  // getWeatherForLocation already has a 4-stage fallback (cache -> Tomorrow.io
  // -> Open-Meteo -> seasonal estimates), but we catch any unexpected throw
  // here as a safety net so the server component never crashes.
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
    console.log("[page.tsx]", location.slug, "weather source:", weatherSource, "temp:", weather.current.temperature_2m);
  } catch (err) {
    console.error("[page.tsx]", location.slug, "weather fetch failed:", err);
    weather = createFallbackWeather(location.lat, location.lon, location.elevation);
    weatherSource = "fallback";
  }

  const usingFallback = weatherSource === "fallback";
  console.log("[page.tsx]", location.slug, "usingFallback:", usingFallback, "has insights:", !!weather.insights);
  const frostAlert = usingFallback ? null : checkFrostRisk(weather.hourly);
  const conditionInfo = weatherCodeToInfo(weather.current.weather_code);
  const now = new Date().toISOString();

  // ── Schema.org structured data (SEO — server only) ──────────────────────
  const pageSchema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": `${BASE_URL}/${location.slug}`,
    name: `${location.name} Weather Forecast`,
    description: `Current weather and 7-day forecast for ${location.name}, ${location.province}, Zimbabwe`,
    url: `${BASE_URL}/${location.slug}`,
    datePublished: now,
    dateModified: now,
    inLanguage: "en",
    isPartOf: { "@id": `${BASE_URL}/#website` },
    publisher: { "@id": `${BASE_URL}/#org` },
    mainEntity: {
      "@type": "Place",
      "@id": `${BASE_URL}/${location.slug}#place`,
      name: location.name,
      geo: {
        "@type": "GeoCoordinates",
        latitude: location.lat,
        longitude: location.lon,
        elevation: {
          "@type": "QuantitativeValue",
          value: location.elevation,
          unitCode: "MTR",
          unitText: "metres",
        },
      },
      address: {
        "@type": "PostalAddress",
        addressRegion: location.province,
        addressCountry: "ZW",
      },
      containedInPlace: {
        "@type": "Country",
        name: "Zimbabwe",
        identifier: "ZW",
      },
    },
    about: {
      "@type": "Observation",
      measurementMethod: "Open-Meteo weather API",
      observationDate: now,
      observationAbout: { "@id": `${BASE_URL}/${location.slug}#place` },
      measuredProperty: [
        { "@type": "PropertyValue", name: "temperature", value: weather.current.temperature_2m, unitCode: "CEL", unitText: "\u00b0C" },
        { "@type": "PropertyValue", name: "apparentTemperature", value: weather.current.apparent_temperature, unitCode: "CEL", unitText: "\u00b0C" },
        { "@type": "PropertyValue", name: "relativeHumidity", value: weather.current.relative_humidity_2m, unitCode: "P1", unitText: "%" },
        { "@type": "PropertyValue", name: "windSpeed", value: weather.current.wind_speed_10m, unitCode: "KMH", unitText: "km/h" },
        { "@type": "PropertyValue", name: "windDirection", value: weather.current.wind_direction_10m, unitCode: "DD", unitText: "\u00b0" },
        { "@type": "PropertyValue", name: "surfacePressure", value: weather.current.surface_pressure, unitCode: "HPA", unitText: "hPa" },
        { "@type": "PropertyValue", name: "uvIndex", value: weather.current.uv_index },
        { "@type": "PropertyValue", name: "cloudCover", value: weather.current.cloud_cover, unitCode: "P1", unitText: "%" },
        { "@type": "PropertyValue", name: "precipitation", value: weather.current.precipitation, unitCode: "MMT", unitText: "mm" },
        { "@type": "PropertyValue", name: "weatherCondition", value: conditionInfo.label },
      ],
    },
  };

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "mukoko weather", item: BASE_URL },
      { "@type": "ListItem", position: 2, name: location.province },
      { "@type": "ListItem", position: 3, name: `${location.name} Weather`, item: `${BASE_URL}/${location.slug}` },
    ],
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: `What is the weather like in ${location.name} today?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: `Currently ${location.name} is ${Math.round(weather.current.temperature_2m)}\u00b0C with ${conditionInfo.label.toLowerCase()}. Humidity is ${weather.current.relative_humidity_2m}% with winds at ${Math.round(weather.current.wind_speed_10m)} km/h.`,
        },
      },
      {
        "@type": "Question",
        name: `What is the 7-day forecast for ${location.name}, Zimbabwe?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: `The 7-day forecast for ${location.name} shows highs of ${Math.round(Math.max(...weather.daily.temperature_2m_max))}\u00b0C and lows of ${Math.round(Math.min(...weather.daily.temperature_2m_min))}\u00b0C. Check mukoko weather for detailed daily and hourly forecasts.`,
        },
      },
      {
        "@type": "Question",
        name: `What province is ${location.name} in?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: `${location.name} is located in ${location.province} province, Zimbabwe, at an elevation of ${location.elevation} metres above sea level.`,
        },
      },
    ],
  };

  return (
    <>
      {/* SEO schemas — server rendered only */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(
          usingFallback ? [breadcrumbSchema] : [pageSchema, breadcrumbSchema, faqSchema]
        ) }}
      />

      {/* All weather UI lives in the client component with per-section error boundaries */}
      <WeatherDashboard
        weather={weather}
        location={location}
        usingFallback={usingFallback}
        frostAlert={frostAlert}
      />
    </>
  );
}
