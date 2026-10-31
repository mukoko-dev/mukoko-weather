import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { weatherCodeToInfo } from "@/lib/weather";
import { getCountryByCode } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { breadcrumbJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/metadata";
import { resolveLocationParam } from "@/lib/load-location";
import { getCachedSeason, loadLocationWeather } from "@/lib/location-payload";
import { JsonLd } from "@/components/layout/JsonLd";
import { WeatherDashboard } from "./WeatherDashboard";
import { SITE_URL } from "@/lib/site";
import {
  countryDisplayName,
  placeLine,
  reconcileCountry,
} from "@/lib/location-country";
import { reconcileElevation } from "@/lib/location-elevation";

// Location lookups go through the shared loadLocation (./load-location) so the
// layout, generateMetadata and the page share one DB round-trip per request.
const loadCountry = cache((code: string) =>
  getCountryByCode(code).catch(() => null),
);

export const dynamic = "force-dynamic";
export async function generateMetadata({
  params,
}: {
  params: Promise<{ location: string }>;
}): Promise<Metadata> {
  const stored = await resolveLocationParam(params);
  if (!stored) return buildPageMetadata({ notFound: true });
  // Metadata has no forecast to reconcile against, so a region borrowed from
  // a seed (possibly across a border) is left out rather than indexed.
  const loc = stored.regionApproximate
    ? { ...stored, country: "", province: "" }
    : stored;

  const countryCode = loc.country ?? "";
  const country = countryCode ? await loadCountry(countryCode) : null;
  const countryName = country?.name ?? countryDisplayName(countryCode);

  const title = `${loc.name} Weather Today — Forecast & Conditions`;
  const description = `Current weather conditions, 7-day forecast, and hourly predictions for ${placeLine(loc.name, loc.province, countryName)}. AI-powered weather intelligence with frost alerts, farming insights, and accurate temperature data from mukoko weather.`;

  // Build dynamic OG image URL with location-specific season from database.
  // Note: the OG route accepts `temp` and `condition` params, but we
  // intentionally omit them here — fetching weather data purely for OG
  // metadata would add a DB round-trip to every SSR render.
  // Wrapped in try/catch — if DB is unavailable, season is simply omitted
  // from OG params rather than breaking all metadata for the page.
  let seasonName = "";
  try {
    const season = await getCachedSeason(loc.country ?? "", loc.lat ?? 0);
    seasonName = season.name;
  } catch {
    // Season unavailable — omit from OG params
  }
  const ogParams = new URLSearchParams({
    title: `${loc.name} Weather`,
    subtitle: `Live forecast for ${placeLine(loc.province, countryName) || loc.name}`,
    location: loc.name,
    province: loc.province,
    ...(seasonName && { season: seasonName }),
    template: "location",
  });
  const ogImageUrl = `${SITE_URL}/api/og?${ogParams.toString()}`;

  const keywords = [
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
  ]
    .map((k) => k.trim())
    .filter((k) => k && k !== "weather");

  return buildPageMetadata({
    title,
    description,
    path: `/${loc.slug}`,
    keywords,
    og: {
      title: `${loc.name} Weather | mukoko weather`,
      description: `Live weather forecast for ${placeLine(loc.name, loc.province, countryName)}. Current conditions, 7-day outlook, and AI-powered insights.`,
      image: {
        url: ogImageUrl,
        width: 1200,
        height: 630,
        alt: `${loc.name} weather forecast`,
      },
    },
    twitter: {
      title: `${loc.name} Weather | mukoko weather`,
      description: `Live weather for ${loc.name}, ${countryName} — current conditions, 7-day forecast, and AI insights.`,
      images: [ogImageUrl],
    },
  });
}

export default async function LocationPage({
  params,
}: {
  params: Promise<{ location: string }>;
}) {
  const rawLocation = await resolveLocationParam(params);
  if (!rawLocation) notFound();
  // Strip MongoDB _id (ObjectId with .toJSON()) before passing to Client Components
  const { _id: _removed, ...storedLocation } =
    rawLocation as typeof rawLocation & {
      _id?: unknown;
    };

  // Fetch weather — double-caught so the page shell ALWAYS renders.
  // getWeatherForLocation already has a 4-stage fallback (cache -> Tomorrow.io
  // -> Open-Meteo -> seasonal estimates), but we catch any unexpected throw
  // here as a safety net so the server component never crashes.
  // Country, season and the signed-in user don't depend on the weather, so
  // start them now and let them run while the weather fetch is in flight
  // (a cache miss there is the slow part of this render). They used to wait
  // for the weather before starting.
  const storedCountry = (storedLocation.country ?? "").toUpperCase();
  const sideData = Promise.all([
    storedCountry ? loadCountry(storedCountry) : Promise.resolve(null),
    getCachedSeason(storedCountry, storedLocation.lat ?? 0),
    getCurrentUser(),
  ]);
  // A rejection here is awaited (and surfaces) below; mark it handled now so
  // it isn't reported as unhandled while the weather await is pending.
  void sideData.catch(() => {});

  const { weather, usingFallback, frostAlert } =
    await loadLocationWeather(storedLocation);

  // A place outside the stored geography can arrive with no country (or one
  // borrowed from a seed across a border). The forecast's time zone names
  // the real one — see src/lib/location-country.ts.
  const location = reconcileElevation(
    reconcileCountry(storedLocation, weather.timezone),
    weather.elevation,
  );
  const countryCode = (location.country ?? "").toUpperCase();

  const conditionInfo = weatherCodeToInfo(weather.current.weather_code);
  // Guard against empty daily arrays — Math.max(...[]) is -Infinity and
  // Math.min(...[]) is Infinity, which would render as garbage in the FAQ schema.
  const dailyHighs = weather.daily.temperature_2m_max;
  const dailyLows = weather.daily.temperature_2m_min;
  const weekHigh = dailyHighs.length
    ? Math.round(Math.max(...dailyHighs))
    : null;
  const weekLow = dailyLows.length ? Math.round(Math.min(...dailyLows)) : null;
  const [storedCountryDoc, storedSeason, currentUser] = await sideData;
  const countryChanged = countryCode !== storedCountry;
  const [countryDoc, season] = countryChanged
    ? await Promise.all([
        countryCode ? loadCountry(countryCode) : Promise.resolve(null),
        getCachedSeason(countryCode, location.lat ?? 0),
      ])
    : [storedCountryDoc, storedSeason];
  const countryName = countryDoc?.name ?? countryDisplayName(countryCode);
  // Strip AuthKit-specific fields before crossing the server/client boundary.
  // AISummary/AISummaryChat only need id + email to decide signed-in vs CTA.
  const aiUser = currentUser
    ? { id: currentUser.id, email: currentUser.email ?? null }
    : null;
  const now = new Date().toISOString();

  // ── Schema.org structured data (SEO — server only) ──────────────────────
  const pageSchema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": `${SITE_URL}/${location.slug}`,
    name: `${location.name} Weather Forecast`,
    description: `Current weather and 7-day forecast for ${placeLine(location.name, location.province, countryName)}`,
    url: `${SITE_URL}/${location.slug}`,
    datePublished: now,
    dateModified: now,
    inLanguage: "en",
    isPartOf: { "@id": `${SITE_URL}/#website` },
    publisher: { "@id": `${SITE_URL}/#org` },
    mainEntity: {
      "@type": "Place",
      "@id": `${SITE_URL}/${location.slug}#place`,
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
        ...(location.province ? { addressRegion: location.province } : {}),
        // An open-ocean spot has no country: omit the property rather than
        // publish an empty ISO 3166-1 code.
        ...(countryCode ? { addressCountry: countryCode } : {}),
      },
      ...(countryCode
        ? {
            containedInPlace: {
              "@type": "Country",
              name: countryName,
              identifier: countryCode,
            },
          }
        : {}),
    },
    about: {
      "@type": "Observation",
      measurementMethod: "Open-Meteo weather API",
      observationDate: now,
      observationAbout: { "@id": `${SITE_URL}/${location.slug}#place` },
      measuredProperty: [
        {
          "@type": "PropertyValue",
          name: "temperature",
          value: weather.current.temperature_2m,
          unitCode: "CEL",
          unitText: "\u00b0C",
        },
        {
          "@type": "PropertyValue",
          name: "apparentTemperature",
          value: weather.current.apparent_temperature,
          unitCode: "CEL",
          unitText: "\u00b0C",
        },
        {
          "@type": "PropertyValue",
          name: "relativeHumidity",
          value: weather.current.relative_humidity_2m,
          unitCode: "P1",
          unitText: "%",
        },
        {
          "@type": "PropertyValue",
          name: "windSpeed",
          value: weather.current.wind_speed_10m,
          unitCode: "KMH",
          unitText: "km/h",
        },
        {
          "@type": "PropertyValue",
          name: "windDirection",
          value: weather.current.wind_direction_10m,
          unitCode: "DD",
          unitText: "\u00b0",
        },
        {
          "@type": "PropertyValue",
          name: "surfacePressure",
          value: weather.current.surface_pressure,
          unitCode: "HPA",
          unitText: "hPa",
        },
        {
          "@type": "PropertyValue",
          name: "uvIndex",
          value: weather.current.uv_index,
        },
        {
          "@type": "PropertyValue",
          name: "cloudCover",
          value: weather.current.cloud_cover,
          unitCode: "P1",
          unitText: "%",
        },
        {
          "@type": "PropertyValue",
          name: "precipitation",
          value: weather.current.precipitation,
          unitCode: "MMT",
          unitText: "mm",
        },
        {
          "@type": "PropertyValue",
          name: "weatherCondition",
          value: conditionInfo.label,
        },
      ],
    },
  };

  const breadcrumbSchema = breadcrumbJsonLd([
    { name: location.province },
    { name: `${location.name} Weather`, path: `/${location.slug}` },
  ]);

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
          text:
            weekHigh !== null && weekLow !== null
              ? `The 7-day forecast for ${location.name} shows highs of ${weekHigh}\u00b0C and lows of ${weekLow}\u00b0C. Check mukoko weather for detailed daily and hourly forecasts.`
              : `Check mukoko weather for the detailed daily and hourly forecast for ${location.name}.`,
        },
      },
      {
        "@type": "Question",
        name: `What province is ${location.name} in?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: `${location.name} is located in ${placeLine(location.province && `${location.province} province`, countryName) || "an unmapped area"}, at an elevation of ${location.elevation} metres above sea level.`,
        },
      },
    ],
  };

  return (
    <>
      {/* SEO schemas — server rendered only */}
      <JsonLd
        data={
          usingFallback
            ? [breadcrumbSchema]
            : [pageSchema, breadcrumbSchema, faqSchema]
        }
      />

      {/* All weather UI lives in the client component with per-section error boundaries */}
      <WeatherDashboard
        weather={weather}
        location={location}
        usingFallback={usingFallback}
        frostAlert={frostAlert}
        season={season}
        countryName={countryName}
        user={aiUser}
      />
    </>
  );
}
