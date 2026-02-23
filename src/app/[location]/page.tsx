import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { checkFrostRisk, createFallbackWeather, weatherCodeToInfo } from "@/lib/weather";
import { getWeatherForLocation, getLocationFromDb, getCountryByCode, getSeasonForDate } from "@/lib/db";
import { WeatherDashboard } from "./WeatherDashboard";

// Deduplicate DB calls between generateMetadata and the page component.
// Both are called for the same request; cache() ensures a single DB round-trip.
const loadLocation = cache((slug: string) => getLocationFromDb(slug).catch(() => null));
const loadCountry = cache((code: string) => getCountryByCode(code).catch(() => null));

// Per-request deduplication only — React cache() does NOT persist across requests.
// generateMetadata and the page component both call this for the same country code;
// cache() ensures a single DB round-trip within one SSR pass. Unlike a module-level
// Map with TTL, this is scoped to the current request and discarded afterward.
const getCachedSeason = cache((countryCode: string) =>
  getSeasonForDate(new Date(), countryCode),
);

export const dynamic = "force-dynamic";

const BASE_URL = "https://weather.mukoko.com";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ location: string }>;
}): Promise<Metadata> {
  const { location: slug } = await params;
  const loc = await loadLocation(slug);
  if (!loc) return { title: "Location not found" };

  const countryCode = loc.country ?? "ZW";
  const country = await loadCountry(countryCode);
  const countryName = country?.name ?? countryCode;

  const title = `${loc.name} Weather Today — Forecast & Conditions`;
  const description = `Current weather conditions, 7-day forecast, and hourly predictions for ${loc.name}, ${loc.province}, ${countryName}. AI-powered weather intelligence with frost alerts, farming insights, and accurate temperature data from mukoko weather.`;

  // Build dynamic OG image URL with location-specific season from database.
  // Note: the OG route accepts `temp` and `condition` params, but we
  // intentionally omit them here — fetching weather data purely for OG
  // metadata would add a DB round-trip to every SSR render.
  // Wrapped in try/catch — if DB is unavailable, season is simply omitted
  // from OG params rather than breaking all metadata for the page.
  let seasonName = "";
  try {
    const season = await getCachedSeason(loc.country ?? "ZW");
    seasonName = season.name;
  } catch {
    // Season unavailable — omit from OG params
  }
  const ogParams = new URLSearchParams({
    title: `${loc.name} Weather`,
    subtitle: `Live forecast for ${loc.province}, ${countryName}`,
    location: loc.name,
    province: loc.province,
    ...(seasonName && { season: seasonName }),
    template: "location",
  });
  const ogImageUrl = `${BASE_URL}/api/og?${ogParams.toString()}`;

  return {
    title,
    description,
    keywords: [
      `${loc.name} weather`,
      `${loc.name} weather today`,
      `${loc.name} forecast`,
      `${loc.name} temperature`,
      `weather in ${loc.name} ${countryName}`,
      `${loc.province} weather`,
      `${loc.name} 7 day forecast`,
      `${loc.name} rain forecast`,
      `${countryName} weather`,
      "mukoko weather",
    ],
    alternates: {
      canonical: `${BASE_URL}/${loc.slug}`,
    },
    openGraph: {
      title: `${loc.name} Weather | mukoko weather`,
      description: `Live weather forecast for ${loc.name}, ${loc.province}, ${countryName}. Current conditions, 7-day outlook, and AI-powered insights.`,
      url: `${BASE_URL}/${loc.slug}`,
      type: "website",
      locale: "en_ZW",
      siteName: "mukoko weather",
      images: [{ url: ogImageUrl, width: 1200, height: 630, alt: `${loc.name} weather forecast` }],
    },
    twitter: {
      card: "summary_large_image",
      title: `${loc.name} Weather | mukoko weather`,
      description: `Live weather for ${loc.name}, ${countryName} — current conditions, 7-day forecast, and AI insights.`,
      images: [ogImageUrl],
    },
  };
}

export default async function LocationPage({
  params,
}: {
  params: Promise<{ location: string }>;
}) {
  const { location: slug } = await params;
  const location = await loadLocation(slug);
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
  } catch {
    weather = createFallbackWeather(location.lat, location.lon, location.elevation);
    weatherSource = "fallback";
  }

  const usingFallback = weatherSource === "fallback";
  const frostAlert = usingFallback ? null : checkFrostRisk(weather.hourly);
  const conditionInfo = weatherCodeToInfo(weather.current.weather_code);
  const countryCode = (location.country ?? "ZW").toUpperCase();
  const [countryDoc, season] = await Promise.all([
    loadCountry(countryCode),
    getCachedSeason(location.country ?? "ZW"),
  ]);
  const countryName = countryDoc?.name ?? countryCode;
  const now = new Date().toISOString();

  // ── Schema.org structured data (SEO — server only) ──────────────────────
  const pageSchema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": `${BASE_URL}/${location.slug}`,
    name: `${location.name} Weather Forecast`,
    description: `Current weather and 7-day forecast for ${location.name}, ${location.province}, ${countryName}`,
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
        addressCountry: countryCode,
      },
      containedInPlace: {
        "@type": "Country",
        name: countryName,
        identifier: countryCode,
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
        name: `What is the 7-day forecast for ${location.name}, ${countryName}?`,
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
          text: `${location.name} is located in ${location.province} province, ${countryName}, at an elevation of ${location.elevation} metres above sea level.`,
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
        season={season}
        countryName={countryName}
      />
    </>
  );
}
